"use strict";
// Node HTTP + WebSocket server for the Word-Compatible Editor.
// - Serves public/ and /api/*
// - Local-directory working storage for drafts, versions, and generated DOCX
// - Server-side DOCX<->HTML conversion reuses the client's own docx.js
//   unmodified via a jsdom shim (server/docxNode.mjs); .docx is regenerated
//   from the HTML state on every save that changes it
// - Version history (<id>.versions.json, capped)
// - Revision-based conflict detection (baseRev -> 409)
// - Hand-rolled WebSocket (/ws) for single-instance presence + live sync
// - LegalAI sessions use short-lived, per-document scoped tokens

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { mintToken, verifyToken } = require("./server/scopedAuth");
const { createStorage } = require("./server/storage");
const { createDataLifecycle, DAY_MS } = require("./server/dataLifecycle");
const { convertToDocx: convertDocToDocx } = require("./server/docConvert");
const { version: APP_VERSION } = require("./package.json");

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";
// Secret used to sign/verify short-lived scoped tokens (see server/scopedAuth.js).
const TOKEN_SECRET = process.env.TOKEN_SECRET || "";
const LEGALAI_BASE_URL = (process.env.LEGALAI_BASE_URL || "").replace(/\/$/, "");
const LEGALAI_CONTENT_PATH = process.env.LEGALAI_CONTENT_PATH || "/doc-editor/{docId}/content";
const LEGALAI_TOKEN_HEADER = process.env.LEGALAI_TOKEN_HEADER || "token";
const LEGALAI_REQUEST_TIMEOUT_MS = Math.max(Number(process.env.LEGALAI_REQUEST_TIMEOUT_MS) || 30000, 1000);
const LEGALAI_AUTO_COMMIT_ENABLED = /^(1|true|yes)$/i.test(process.env.LEGALAI_AUTO_COMMIT_ENABLED || "false");
const LEGALAI_AUTO_COMMIT_INTERVAL_MS = Math.max(Number(process.env.LEGALAI_AUTO_COMMIT_INTERVAL_MS) || 300000, 60000);
const VERSION_HISTORY_ENABLED = !/^(0|false|no)$/i.test(process.env.VERSION_HISTORY_ENABLED || "true");
const STARTUP_DRAFT_PURGE_ENABLED = !/^(0|false|no)$/i.test(process.env.STARTUP_DRAFT_PURGE_ENABLED || "true");
const DATA_RETENTION_MS = Math.max(Number(process.env.DATA_RETENTION_HOURS) || 24, 1) * 60 * 60 * 1000;
const DATA_CLEANUP_INTERVAL_MS = Math.max(Number(process.env.DATA_CLEANUP_INTERVAL_MS) || DAY_MS, 60000);
const DISK_CHECK_INTERVAL_MS = Math.max(Number(process.env.DISK_CHECK_INTERVAL_MS) || 300000, 60000);
const DISK_WARNING_PERCENT = Math.min(Math.max(Number(process.env.DISK_WARNING_PERCENT) || 70, 1), 99);
const DISK_CRITICAL_PERCENT = Math.min(Math.max(Number(process.env.DISK_CRITICAL_PERCENT) || 85, DISK_WARNING_PERCENT), 100);
const MAX_BODY = 64 * 1024 * 1024; // 64 MB
const MAX_VERSIONS = 10;
const VERSION_RETENTION_MS = 3 * DAY_MS;
const VERSION_MIN_INTERVAL = 90 * 1000; // min ms between auto snapshots

// Server-side reuse of the client's zero-dependency OOXML parser/exporter
// (public/js/docx.js) via a jsdom DOM shim — see server/docxNode.mjs.
let _docxNodePromise = null;
function docxNode() {
  if (!_docxNodePromise) _docxNodePromise = import("./server/docxNode.mjs");
  return _docxNodePromise;
}
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
// Regenerate the canonical .docx for a document from its current HTML state.
// Best-effort: a failure here must never block saving the HTML state itself,
// since that remains the editor's source of truth — but it does mean the
// .docx on disk (and anything written back to LegalAI) can go briefly stale
// until the next successful save. Log loudly so that's visible operationally.
async function regenerateDocx(meta) {
  if (meta.state == null) return false;
  try {
    const docx = await docxNode();
    let baseBytes = await storage.readFile(sourceDocxKey(meta.id));
    if (!baseBytes) {
      baseBytes = await storage.readFile(docxKey(meta.id));
      if (baseBytes) await storage.writeFile(sourceDocxKey(meta.id), baseBytes);
    }
    const blob = await docx.buildDocxFromHtml(meta.state, {
      title: meta.title, pageSetup: meta.pageSetup, comments: meta.comments,
      baseDocx: baseBytes ? toArrayBuffer(baseBytes) : null,
    });
    const bytes = Buffer.from(await blob.arrayBuffer());
    await storage.writeFile(docxKey(meta.id), bytes);
    return true;
  } catch (e) {
    console.error(`docx regeneration failed for ${meta.id}:`, e.message);
    return false;
  }
}

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR
  ? (path.isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : path.join(ROOT, process.env.DATA_DIR))
  : path.join(ROOT, "data");
// Local working storage. LegalAI remains the system of record for formally
// committed business documents; this directory supports editor drafts,
// versions, the document library, and generated DOCX artifacts.
const storage = createStorage(DATA);
let dataLifecycle = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}
function sendVersionPage(res) {
  const version = escHtml(APP_VERSION);
  send(res, 200, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Word Editor ${version}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { padding: 2rem 3rem; text-align: center; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 1rem; }
    h1 { margin: 0 0 .75rem; font-size: 1.25rem; font-weight: 600; }
    output { font: 700 2rem/1.2 ui-monospace, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>Word Editor</h1>
    <output aria-label="Version">${version}</output>
  </main>
</body>
</html>`, { "Content-Type": "text/html; charset=utf-8" });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSON(req) {
  const raw = (await readBody(req)).toString();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

// LegalAI uses its business contract id directly as the editor document id.
// Keep the accepted alphabet path-safe: no slash, backslash, dot segment or
// percent-decoded traversal can be represented by this pattern.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function validId(id) { return ID_RE.test(id); }

function docKey(id) { return `${id}.json`; }
function docxKey(id) { return `${id}.docx`; }
function sourceDocxKey(id) { return `${id}.source.docx`; }
function versionsKey(id) { return `${id}.versions.json`; }

async function readMeta(id) {
  const buf = await storage.readFile(docKey(id));
  if (!buf) return null;
  try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
}
async function readVersions(id) {
  const buf = await storage.readFile(versionsKey(id));
  if (!buf) return [];
  try { return JSON.parse(buf.toString("utf8")); } catch { return []; }
}
async function snapshotVersion(id, meta, force = false) {
  if (!VERSION_HISTORY_ENABLED) return;
  if (meta.state == null) return;
  const versions = (await readVersions(id)).filter((version) => Number(version?.t) >= Date.now() - VERSION_RETENTION_MS);
  const last = versions[versions.length - 1];
  if (!force && last && Date.now() - last.t < VERSION_MIN_INTERVAL) return;
  if (last && last.state === meta.state && last.title === meta.title) return;
  versions.push({
    t: Date.now(), rev: meta.rev, title: meta.title, state: meta.state,
    pageSetup: meta.pageSetup || null, comments: meta.comments || [],
  });
  while (versions.length > MAX_VERSIONS) versions.shift();
  await storage.writeFile(versionsKey(id), Buffer.from(JSON.stringify(versions)));
}
async function writeMeta(id, body, opts = {}) {
  const existing = (await readMeta(id)) || { id, title: "Untitled", createdAt: Date.now(), rev: 0 };
  const next = {
    id,
    title: body.title != null ? String(body.title).slice(0, 300) : existing.title,
    state: body.state !== undefined ? body.state : existing.state,
    pageSetup: body.pageSetup !== undefined ? body.pageSetup : (existing.pageSetup || null),
    comments: body.comments !== undefined ? body.comments : (existing.comments || []),
    trackChanges: body.trackChanges !== undefined ? !!body.trackChanges : !!existing.trackChanges,
    // The tenantId/contractId mapping (see server/scopedAuth.js and
    // LegalAI session binding, preserved for the document's lifetime.
    tenantId: body.tenantId !== undefined ? (body.tenantId ? String(body.tenantId).slice(0, 200) : null) : (existing.tenantId || null),
    contractId: body.contractId !== undefined ? (body.contractId ? String(body.contractId).slice(0, 200) : null) : (existing.contractId || null),
    integration: body.integration !== undefined ? String(body.integration || "").slice(0, 50) : (existing.integration || null),
    lastCommittedRev: opts.resetCommitState ? null : (existing.lastCommittedRev ?? null),
    lastCommittedAt: opts.resetCommitState ? null : (existing.lastCommittedAt ?? null),
    closeCommittedRev: opts.resetCommitState ? null : (existing.closeCommittedRev ?? null),
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
    rev: (existing.rev || 0) + 1,
  };
  await storage.writeFile(docKey(id), Buffer.from(JSON.stringify(next)));
  if (body.state !== undefined) await snapshotVersion(id, next, opts.forceVersion);
  // The .docx on disk is the write-back artifact for LegalAI; keep it in lock
  // step with whatever HTML state we just persisted so it never goes stale.
  // Exception: right after import, the uploaded bytes ARE the freshest,
  // highest-fidelity .docx we'll ever have for this content — regenerating
  // from our HTML approximation immediately would throw fidelity away before
  // the user has changed anything, so that one call opts out via skipDocxRegen.
  const docxFresh = opts.skipDocxRegen
    ? await storage.exists(docxKey(id))
    : (body.state !== undefined ? await regenerateDocx(next) : await storage.exists(docxKey(id)));
  return next;
}
async function recordSuccessfulCommit(id, rev, reason) {
  const latest = await readMeta(id);
  if (!latest) return null;
  latest.lastCommittedRev = rev;
  latest.lastCommittedAt = Date.now();
  if (reason === "close") latest.closeCommittedRev = rev;
  await storage.writeFile(docKey(id), Buffer.from(JSON.stringify(latest)));
  return latest;
}
function metaSummary(d) {
  return { id: d.id, title: d.title, updatedAt: d.updatedAt, createdAt: d.createdAt, rev: d.rev || 0 };
}

// A LegalAI session is deliberately memory-only: the user's business token
// is never written into document metadata or local storage. It is refreshed
// whenever the host opens the editor and is only retained so the optional
// server-side timer (disabled by default) can commit while that session lives.
const legalAiSessions = new Map(); // docId -> { businessToken, lastCommittedRev, committing }

function legalAiContentUrl(docId) {
  if (!LEGALAI_BASE_URL) throw Object.assign(new Error("LEGALAI_BASE_URL is not configured"), { status: 503 });
  const relative = LEGALAI_CONTENT_PATH.replace("{docId}", encodeURIComponent(docId));
  return LEGALAI_BASE_URL + (relative.startsWith("/") ? relative : `/${relative}`);
}

function legalAiHeaders(businessToken, extra = {}) {
  return { [LEGALAI_TOKEN_HEADER]: businessToken, ...extra };
}

async function legalAiFetch(url, options) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(LEGALAI_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error?.cause;
    const code = String(cause?.code || error?.code || error?.name || "FETCH_FAILED");
    const detail = String(cause?.message || error?.message || "unknown network error");
    const method = String(options?.method || "GET").toUpperCase();
    let target = "LegalAI";
    try {
      const parsed = new URL(url);
      target = `${parsed.origin}${parsed.pathname}`;
    } catch {}
    console.error("LegalAI request error", { method, target, code, detail });
    throw Object.assign(
      new Error(`LegalAI request failed (${code}): ${detail}`),
      { status: 502, causeCode: code }
    );
  }
}

async function downloadLegalAiDocument(docId, businessToken) {
  const response = await legalAiFetch(legalAiContentUrl(docId), {
    method: "GET",
    headers: legalAiHeaders(businessToken, { Accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw Object.assign(new Error(`LegalAI document download failed (${response.status}): ${detail}`), { status: response.status === 401 ? 401 : 502 });
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const detail = (await response.text()).slice(0, 500);
    let parsed;
    try { parsed = JSON.parse(detail); } catch {}
    throw Object.assign(new Error(`LegalAI document download was rejected: ${parsed?.msg || parsed?.error || detail}`), { status: 401 });
  }
  const declaredSize = Number(response.headers.get("content-length")) || 0;
  if (declaredSize > MAX_BODY) throw Object.assign(new Error("LegalAI document exceeds the 64 MB editor limit"), { status: 413 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BODY) throw Object.assign(new Error("LegalAI document exceeds the 64 MB editor limit"), { status: 413 });
  return bytes;
}

async function publishLegalAiDocument(meta, businessToken, reason) {
  const bytes = await storage.readFile(docxKey(meta.id));
  if (!bytes) throw Object.assign(new Error("generated DOCX is unavailable"), { status: 500 });

  const boundary = `----word-editor-${crypto.randomBytes(12).toString("hex")}`;
  const safeName = String(meta.title || meta.id).replace(/["\r\n]/g, "_");
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeName}.docx"\r\n` +
    "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([prefix, bytes, suffix]);
  const response = await legalAiFetch(legalAiContentUrl(meta.id), {
    method: "POST",
    headers: legalAiHeaders(businessToken, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "X-Word-Editor-Save-Reason": reason,
    }),
    body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`LegalAI document save failed (${response.status}): ${responseText.slice(0, 500)}`), { status: 502 });
  }
  try {
    const parsed = responseText ? JSON.parse(responseText) : { ok: true };
    // LegalAI's BusinessException handler returns HTTP 200 with a non-zero
    // BaseResponse code, so HTTP status alone cannot prove the upstream write worked.
    if (parsed && parsed.code != null && String(parsed.code) !== "0") {
      throw Object.assign(new Error(`LegalAI document save was rejected: ${parsed.msg || parsed.code}`), { status: 502 });
    }
    return parsed;
  } catch (e) {
    if (e.status) throw e;
    return { ok: true, response: responseText.slice(0, 500) };
  }
}

async function commitLegalAiDocument(id, businessToken, reason = "manual") {
  const meta = await readMeta(id);
  if (!meta) throw Object.assign(new Error("document not found"), { status: 404 });
  if (meta.integration !== "legalai" || meta.contractId !== id) {
    throw Object.assign(new Error("document is not bound to this LegalAI contract"), { status: 409 });
  }
  if (!businessToken) throw Object.assign(new Error("LegalAI business token is required"), { status: 401 });

  const session = legalAiSessions.get(id) || { lastCommittedRev: meta.lastCommittedRev ?? null, committing: false };
  if (session.committing) {
    throw Object.assign(new Error("document commit is already in progress; retry close after it completes"), { status: 409 });
  }
  if (meta.lastCommittedRev === meta.rev) {
    session.lastCommittedRev = meta.rev;
    legalAiSessions.set(id, session);
    if (reason === "close") {
      await recordSuccessfulCommit(id, meta.rev, reason);
      await cleanupClosedDocument(id, meta.rev);
    }
    return { ok: true, skipped: "no-changes", rev: meta.rev };
  }
  session.businessToken = businessToken;
  session.committing = true;
  legalAiSessions.set(id, session);
  try {
    const docxFresh = await regenerateDocx(meta);
    if (!docxFresh) throw Object.assign(new Error("could not generate the current DOCX; LegalAI was not updated"), { status: 500 });
    const legalAi = await publishLegalAiDocument(meta, businessToken, reason);
    session.lastCommittedRev = meta.rev;
    await recordSuccessfulCommit(id, meta.rev, reason);
    if (reason === "close") await cleanupClosedDocument(id, meta.rev);
    return { ok: true, rev: meta.rev, reason, legalAi };
  } finally {
    session.committing = false;
  }
}

function credentialFrom(req, url) {
  const h = req.headers["authorization"] || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  if (url) {
    const t = url.searchParams.get("token");
    if (t) return t;
  }
  return "";
}
// LegalAI session credentials are short-lived scoped tokens bound to one
// tenantId/contractId/editorDocumentId. Standalone editor documents remain
// accessible without a token; LegalAI-bound documents always require their
// scoped token.
function authenticateRequest(req, url) {
  const cred = credentialFrom(req, url);
  if (cred && TOKEN_SECRET) {
    const payload = verifyToken(TOKEN_SECRET, cred);
    if (payload) return { ok: true, scoped: payload, anonymous: false };
    return { ok: false, scoped: null, anonymous: false };
  }
  return { ok: true, scoped: null, anonymous: true };
}
// pathDocId: the :id segment of /api/documents/:id/... for the requested
// route, or null for routes with no specific document. Scoped tokens are only
// valid against their own document's routes.
async function authorized(req, url, pathDocId) {
  const { ok, scoped, anonymous } = authenticateRequest(req, url);
  if (!ok) return false;
  if (pathDocId && anonymous) {
    const doc = await readMeta(pathDocId);
    if (doc && doc.integration === "legalai") return false;
  }
  if (!scoped) return true;
  return !!pathDocId && scoped.editorDocumentId === pathDocId;
}

// ---- server-side HTML helpers (zero-dependency) ----

const BLOCK_TAGS = new Set(["p","div","h1","h2","h3","h4","h5","h6","ol","ul","li","table","tr","pre","blockquote","hr"]);

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}
function htmlToPlainText(html) {
  let s = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "</p>\n")
    .replace(/<\/h[1-6]>/gi, "</h$&>\n")
    .replace(/<\/li>/gi, "</li>\n")
    .replace(/<\/tr>/gi, "</tr>\n")
    .replace(/<\/div>/gi, "</div>\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
  return s.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
// See public/js/editor.js's countWords() for why CJK characters are counted
// individually rather than as space-delimited words.
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힣]/gu;
function countWords(html) {
  const text = htmlToPlainText(html).trim();
  const cjkCount = (text.match(CJK_CHAR) || []).length;
  const nonCjkText = text.replace(CJK_CHAR, " ").trim();
  const nonCjkWords = nonCjkText ? nonCjkText.split(/\s+/).length : 0;
  const chars = text.replace(/\s/g, "").length;
  return { words: cjkCount + nonCjkWords, chars };
}
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// HTTP header values must be Latin1 — a raw Chinese (or any non-ASCII) title
// passed straight into Content-Disposition throws ERR_INVALID_CHAR and 500s
// the request. RFC 5987's filename* carries the real UTF-8 name; filename=
// stays as an ASCII-safe fallback for older clients that don't read filename*.
function contentDisposition(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "download";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
function exportStandaloneHtml(html, title) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(title || "Document")}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4;max-width:8.5in;margin:24px auto;padding:0 1in;color:#111}</style>
</head><body>${html}</body></html>`;
}
function applyFormat(html, cmd, value) {
  // Wraps the ENTIRE provided html fragment with the formatting elements.
  // The caller is responsible for extracting the precise sub-range to format.
  // Map keys are lowercase (cmd arrives lowercased by the caller).
  const map = {
    bold:                  (h) => `<strong>${h}</strong>`,
    italic:                (h) => `<em>${h}</em>`,
    underline:             (h) => `<span style="text-decoration:underline">${h}</span>`,
    strikethrough:         (h) => `<s>${h}</s>`,
    subscript:             (h) => `<sub>${h}</sub>`,
    superscript:           (h) => `<sup>${h}</sup>`,
    forecolor:             (h) => value ? `<span style="color:${escHtml(value)}">${h}</span>` : h,
    hilitecolor:           (h) => value ? `<span style="background:${escHtml(value)}">${h}</span>` : h,
    fontname:              (h) => value ? `<span style="font-family:${escHtml(value)}">${h}</span>` : h,
    fontsize:              (h) => value ? `<span style="font-size:${escHtml(value)}">${h}</span>` : h,
    formatblock:           (h) => value ? `<${value}>${h}</${value}>` : h,
    justifyleft:           (h) => `<div style="text-align:left">${h}</div>`,
    justifycenter:         (h) => `<div style="text-align:center">${h}</div>`,
    justifyright:          (h) => `<div style="text-align:right">${h}</div>`,
    justifyfull:           (h) => `<div style="text-align:justify">${h}</div>`,
    insertorderedlist:     (h) => `<ol>${h.split(/\n+/).filter(Boolean).map((l) => `<li>${l}</li>`).join("")}</ol>`,
    insertunorderedlist:   (h) => `<ul>${h.split(/\n+/).filter(Boolean).map((l) => `<li>${l}</li>`).join("")}</ul>`,
  };
  const fn = map[cmd];
  if (!fn) throw new Error("unknown format command: " + cmd);
  return fn(html);
}

// ---- API ----
async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p === "/api/health") return sendJSON(res, 200, { ok: true, uptime: process.uptime() });

  // LegalAI bootstrap is the only unauthenticated word-editor route. The
  // supplied business token is immediately validated by using it to download
  // the requested contract from LegalAI. After that succeeds we exchange it
  // for a short-lived token scoped to this one editor document.
  if (p === "/api/integrations/legalai/session" && method === "POST") {
    if (!TOKEN_SECRET) return sendJSON(res, 503, { error: "TOKEN_SECRET is required for LegalAI integration" });
    const body = await readJSON(req);
    const id = String(body.docId || "");
    const businessToken = String(body.businessToken || "");
    if (!validId(id)) return sendJSON(res, 400, { error: "bad docId" });
    if (!businessToken) return sendJSON(res, 401, { error: "businessToken is required" });

    let bytes = await downloadLegalAiDocument(id, businessToken);
    const activeDocument = rooms.has(id) && rooms.get(id).size > 0 ? await readMeta(id) : null;
    if (activeDocument && activeDocument.integration === "legalai" && activeDocument.contractId === id) {
      const currentSession = legalAiSessions.get(id) || { lastCommittedRev: activeDocument.lastCommittedRev ?? null, committing: false };
      currentSession.businessToken = businessToken;
      legalAiSessions.set(id, currentSession);
      const minted = mintToken(TOKEN_SECRET, {
        tenantId: body.tenantId, contractId: id, editorDocumentId: id, ttlSeconds: 60 * 60,
      });
      return sendJSON(res, 200, {
        token: minted.token,
        expiresAt: minted.payload.exp,
        document: metaSummary(activeDocument),
        reusedActiveSession: true,
      });
    }
    const fileType = String(body.fileType || "docx").replace(/^\./, "").toLowerCase();
    const docx = await docxNode();
    if (fileType === "doc" || fileType === "dot" || docx.isLegacyOleFile(bytes)) {
      try { bytes = await convertDocToDocx(bytes, `${body.title || id}.${fileType || "doc"}`); }
      catch (e) {
        const unavailable = e.code === "SOFFICE_UNAVAILABLE";
        return sendJSON(res, unavailable ? 501 : 422, {
          error: unavailable ? "this server has no .doc converter installed" : `could not convert LegalAI document: ${e.message}`,
        });
      }
    }

    let parsed;
    try { parsed = await docx.importDocx(toArrayBuffer(bytes)); }
    catch (e) { return sendJSON(res, 422, { error: `could not parse LegalAI DOCX: ${e.message}` }); }

    await storage.writeFile(sourceDocxKey(id), bytes);
    await storage.writeFile(docxKey(id), bytes);
    const document = await writeMeta(id, {
      title: parsed.title || String(body.title || id).slice(0, 300),
      state: parsed.html,
      pageSetup: parsed.pageSetup,
      comments: parsed.comments,
      tenantId: body.tenantId,
      contractId: id,
      integration: "legalai",
    }, { skipDocxRegen: true, resetCommitState: true });
    await recordSuccessfulCommit(id, document.rev, "bootstrap");
    legalAiSessions.set(id, { businessToken, lastCommittedRev: document.rev, committing: false });

    const minted = mintToken(TOKEN_SECRET, {
      tenantId: body.tenantId, contractId: id, editorDocumentId: id, ttlSeconds: 60 * 60,
    });
    return sendJSON(res, 200, {
      token: minted.token,
      expiresAt: minted.payload.exp,
      document: metaSummary(document),
    });
  }

  // A scoped token is only valid against routes for its own document.
  const pathDocId = (p.match(/^\/api\/documents\/([^/]+)/) || [])[1] || null;
  if (!(await authorized(req, url, pathDocId))) return sendJSON(res, 401, { error: "unauthorized" });

  let integrationMatch = p.match(/^\/api\/documents\/([^/]+)\/commit$/);
  if (integrationMatch && method === "POST") {
    const id = integrationMatch[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const body = await readJSON(req);
    const session = legalAiSessions.get(id);
    const businessToken = String(req.headers["x-legalai-token"] || body.businessToken || session?.businessToken || "");
    const result = await commitLegalAiDocument(id, businessToken, String(body.reason || "manual").slice(0, 30));
    return sendJSON(res, 200, result);
  }

  if (p === "/api/documents" && method === "GET") {
    const keys = (await storage.listKeys(".json")).filter((f) => !f.endsWith(".versions.json"));
    const list = (await Promise.all(keys.map(async (f) => {
      try {
        const buf = await storage.readFile(f);
        return buf ? metaSummary(JSON.parse(buf.toString("utf8"))) : null;
      } catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
    return sendJSON(res, 200, list);
  }

  if (p === "/api/documents" && method === "POST") {
    const body = await readJSON(req);
    const id = crypto.randomUUID();
    const doc = await writeMeta(id, {
      title: body.title || "Untitled", state: body.state !== undefined ? body.state : null,
      tenantId: body.tenantId, contractId: body.contractId,
    });
    return sendJSON(res, 200, doc);
  }

  // Import a .docx (or a legacy .doc/.dot, converted first via LibreOffice —
  // see server/docConvert.js): parse it server-side into HTML state right
  // away, so the standalone editor's "open file" flow gets a document that
  // isn't blank. A raw upload that still fails to
  // parse as OOXML after that is rejected with a clear error instead of
  // silently creating an empty document.
  if (p === "/api/documents/import" && method === "POST") {
    const body = await readJSON(req);
    if (!body.data) return sendJSON(res, 400, { error: "no data" });
    const id = crypto.randomUUID();
    const fallbackTitle = String(body.name || "Imported").replace(/\.(docx?|dot)$/i, "").slice(0, 300);
    let bytes = Buffer.from(body.data, "base64");

    const docx = await docxNode();
    if (docx.isLegacyOleFile(bytes)) {
      try {
        bytes = await convertDocToDocx(bytes, body.name);
      } catch (e) {
        const unavailable = e.code === "SOFFICE_UNAVAILABLE";
        return sendJSON(res, unavailable ? 501 : 422, {
          error: unavailable
            ? "this server has no .doc converter installed"
            : "could not convert this legacy .doc file: " + e.message,
          hint: unavailable
            ? "install LibreOffice (soffice) on the server, or convert the file to .docx manually and re-upload"
            : "the file may be corrupt, password-protected, or use an unsupported legacy format",
        });
      }
    }

    let parsed;
    try {
      parsed = await docx.importDocx(toArrayBuffer(bytes));
    } catch (e) {
      return sendJSON(res, 422, {
        error: "could not parse .docx: " + e.message,
        hint: "only .docx (OOXML) is supported — legacy binary .doc files must be converted to .docx before import",
      });
    }

    await storage.writeFile(sourceDocxKey(id), bytes);
    await storage.writeFile(docxKey(id), bytes);
    const doc = await writeMeta(id, {
      title: parsed.title || fallbackTitle,
      state: parsed.html,
      pageSetup: parsed.pageSetup,
      comments: parsed.comments,
      tenantId: body.tenantId, contractId: body.contractId,
    }, { skipDocxRegen: true });
    return sendJSON(res, 200, { id: doc.id, title: doc.title, hasDocx: true, rev: doc.rev });
  }

  let m = p.match(/^\/api\/documents\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    if (method === "GET") {
      const doc = await readMeta(id);
      return doc ? sendJSON(res, 200, doc) : sendJSON(res, 404, { error: "not found" });
    }
    if (method === "PUT") {
      const existing = await readMeta(id);
      if (!existing) return sendJSON(res, 404, { error: "not found" });
      const body = await readJSON(req);
      // Optimistic concurrency: caller may send the rev it based its edit on.
      if (body.baseRev != null && body.baseRev !== (existing.rev || 0)) {
        return sendJSON(res, 409, { error: "conflict", current: existing });
      }
      return sendJSON(res, 200, await writeMeta(id, body));
    }
    if (method === "DELETE") {
      for (const k of [docKey(id), docxKey(id), sourceDocxKey(id), versionsKey(id)]) {
        await storage.deleteFile(k);
      }
      closeRoom(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  m = p.match(/^\/api\/documents\/([^/]+)\/docx$/);
  if (m) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    if (method === "PUT") {
      const body = await readJSON(req);
      if (!body.data) return sendJSON(res, 400, { error: "no data" });
      const bytes = Buffer.from(body.data, "base64");
      if (!(await storage.exists(sourceDocxKey(id)))) await storage.writeFile(sourceDocxKey(id), bytes);
      await storage.writeFile(docxKey(id), bytes);
      return sendJSON(res, 200, { ok: true });
    }
    if (method === "GET") {
      const docxBytes = await storage.readFile(docxKey(id));
      if (!docxBytes) return sendJSON(res, 404, { error: "no docx" });
      const meta = await readMeta(id);
      const name = (meta && meta.title) || id;
      return send(res, 200, docxBytes, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": contentDisposition(`${name}.docx`),
      });
    }
  }

  m = p.match(/^\/api\/documents\/([^/]+)\/versions$/);
  if (m && method === "GET") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const versions = (await readVersions(id)).map((v, i) => ({
      index: i, t: v.t, rev: v.rev, title: v.title, size: v.state ? v.state.length : 0,
    }));
    return sendJSON(res, 200, versions);
  }

  m = p.match(/^\/api\/documents\/([^/]+)\/versions\/(\d+)$/);
  if (m && method === "GET") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const v = (await readVersions(id))[Number(m[2])];
    return v ? sendJSON(res, 200, v) : sendJSON(res, 404, { error: "not found" });
  }

  m = p.match(/^\/api\/documents\/([^/]+)\/restore$/);
  if (m && method === "POST") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const existing = await readMeta(id);
    if (!existing) return sendJSON(res, 404, { error: "not found" });
    const body = await readJSON(req);
    const v = (await readVersions(id))[Number(body.index)];
    if (!v) return sendJSON(res, 404, { error: "version not found" });
    await snapshotVersion(id, existing, true); // keep the pre-restore state recoverable
    const doc = await writeMeta(id, { title: v.title, state: v.state, pageSetup: v.pageSetup, comments: v.comments || [] }, { forceVersion: true });
    broadcast(id, null, { type: "update", from: { id: "server", user: "Version restore", color: "#666" }, rev: doc.rev, title: doc.title, state: doc.state, pageSetup: doc.pageSetup, comments: doc.comments });
    return sendJSON(res, 200, doc);
  }

  // ---------------------------------------------------------------
  // RESTful document-content API (mirrors the SDK commands)
  // ---------------------------------------------------------------

  // GET /api/documents/{id}/content   → { html, text }
  // PUT /api/documents/{id}/content   → set content { html? }
  // POST /api/documents/{id}/insert-html → append { html }
  // POST /api/documents/{id}/insert-text → append { text }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/content$/))) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    if (method === "GET") {
      const html = (doc.state || "").replace(/^(<p><br><\/p>\s*)+$/, "");
      const text = html ? htmlToPlainText(html) : "";
      const wc = countWords(html);
      return sendJSON(res, 200, { id: doc.id, title: doc.title, html, text, ...wc, pageSetup: doc.pageSetup || null, rev: doc.rev });
    }
    if (method === "PUT") {
      const body = await readJSON(req);
      const updated = await writeMeta(id, { state: body.html !== undefined ? body.html : doc.state, title: body.title !== undefined ? body.title : doc.title });
      broadcast(id, null, { type: "update", from: { id: "api", user: "REST API", color: "#666" }, rev: updated.rev, title: updated.title, state: updated.state, pageSetup: updated.pageSetup, comments: updated.comments });
      return sendJSON(res, 200, { ok: true, rev: updated.rev });
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }

  // GET /api/documents/{id}/text   → { text }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/text$/))) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    return sendJSON(res, 200, { text: htmlToPlainText(doc.state || "") });
  }

  // POST /api/documents/{id}/insert-html   append HTML to the stored document
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/insert-html$/)) && method === "POST") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    if (doc.state == null) doc.state = "<p><br></p>";
    const body = await readJSON(req);
    const fragment = String(body.html || "").trim();
    if (!fragment) return sendJSON(res, 400, { error: "html required" });
    const state = doc.state.replace(/<p><br><\/p>\s*$/, "") + fragment + "<p><br></p>";
    const updated = await writeMeta(id, { state });
    broadcast(id, null, { type: "update", from: { id: "api", user: "REST API", color: "#666" }, rev: updated.rev, title: updated.title, state: updated.state });
    return sendJSON(res, 200, { ok: true, rev: updated.rev });
  }

  // POST /api/documents/{id}/insert-text   append plain-text (wraps in <p>)
  // shortcut — same as insert-html but auto-paragraphs
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/insert-text$/)) && method === "POST") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    const body = await readJSON(req);
    const text = String(body.text || "").trim();
    if (!text) return sendJSON(res, 400, { error: "text required" });
    const html = text.split(/\r?\n/).filter(Boolean).map((l) => `<p>${escHtml(l)}</p>`).join("");
    const state = (doc.state || "<p><br></p>").replace(/<p><br><\/p>\s*$/, "") + html + "<p><br></p>";
    const updated = await writeMeta(id, { state });
    broadcast(id, null, { type: "update", from: { id: "api", user: "REST API", color: "#666" }, rev: updated.rev, title: updated.title, state: updated.state });
    return sendJSON(res, 200, { ok: true, rev: updated.rev });
  }

  // PUT /api/documents/{id}/title   → { title }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/title$/)) && method === "PUT") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    const body = await readJSON(req);
    const updated = await writeMeta(id, { title: String(body.title || doc.title).slice(0, 300) });
    return sendJSON(res, 200, { ok: true, rev: updated.rev, title: updated.title });
  }

  // GET /api/documents/{id}/meta  →  { id, title, rev, words, chars, pageSetup, trackChanges, commentCount }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/meta$/)) && method === "GET") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    const wc = countWords(doc.state || "");
    return sendJSON(res, 200, {
      id: doc.id, title: doc.title, rev: doc.rev || 0,
      pageSetup: doc.pageSetup || null, trackChanges: !!doc.trackChanges,
      commentCount: (doc.comments || []).length, ...wc,
    });
  }
  // PUT /api/documents/{id}/meta  →  update { title?, pageSetup? }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/meta$/)) && method === "PUT") {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    const body = await readJSON(req);
    const patch = {};
    if (body.title !== undefined) patch.title = String(body.title).slice(0, 300);
    if (body.pageSetup !== undefined) patch.pageSetup = body.pageSetup;
    const updated = await writeMeta(id, patch);
    return sendJSON(res, 200, { ok: true, rev: updated.rev, title: updated.title, pageSetup: updated.pageSetup });
  }

  // GET /api/documents/{id}/export?fmt=docx|html|txt  → download
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/export$/))) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    const fmt = url.searchParams.get("fmt") || "docx";
    const title = doc.title || "document";
    try {
      if (fmt === "txt") {
        const text = htmlToPlainText(doc.state || "");
        return send(res, 200, text, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": contentDisposition(`${title}.txt`) });
      }
      if (fmt === "html") {
        const standalone = exportStandaloneHtml(doc.state || "", doc.title || "Document");
        return send(res, 200, standalone, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": contentDisposition(`${title}.html`) });
      }
      // docx — rely on the editor .docx binary if stored
      if (fmt === "docx") {
        const docxBytes = await storage.readFile(docxKey(id));
        if (!docxBytes) return sendJSON(res, 400, { error: "unsupported or unavailable format: docx" });
        return send(res, 200, docxBytes, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": contentDisposition(`${title}.docx`),
        });
      }
      return sendJSON(res, 400, { error: `unsupported or unavailable format: ${fmt}` });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ---- comments ----
  // GET  /api/documents/{id}/comments     → { comments }
  // POST /api/documents/{id}/comments     → add { text, author? }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/comments$/))) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    if (method === "GET") return sendJSON(res, 200, { comments: doc.comments || [] });
    if (method === "POST") {
      const body = await readJSON(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJSON(res, 400, { error: "text required" });
      const c = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), author: body.author || "API", text, createdAt: Date.now(), resolved: false, replies: [] };
      const comments = [...(doc.comments || []), c];
      await writeMeta(id, { comments });
      return sendJSON(res, 200, { ok: true, id: c.id });
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }

  // ---- track changes ----
  // GET  /api/documents/{id}/track-changes  → { enabled }
  // PUT  /api/documents/{id}/track-changes  → { enabled }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/track-changes$/))) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    if (method === "GET") return sendJSON(res, 200, { enabled: !!doc.trackChanges });
    if (method === "PUT") {
      const body = await readJSON(req);
      const on = body.enabled === true || body.enabled === "true";
      await writeMeta(id, { trackChanges: on });
      return sendJSON(res, 200, { ok: true, enabled: on });
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }

  // ---- page setup ----
  // GET  /api/documents/{id}/page-setup → { pageSetup }
  // PUT  /api/documents/{id}/page-setup → { pageSetup? }
  if ((m = p.match(/^\/api\/documents\/([^/]+)\/page-setup$/))) {
    const id = m[1];
    if (!validId(id)) return sendJSON(res, 400, { error: "bad id" });
    const doc = await readMeta(id);
    if (!doc) return sendJSON(res, 404, { error: "not found" });
    if (method === "GET") return sendJSON(res, 200, { pageSetup: doc.pageSetup || null });
    if (method === "PUT") {
      const body = await readJSON(req);
      const merged = { ...(doc.pageSetup || {}), ...(body.pageSetup || {}) };
      if (body.size) merged.size = body.size;
      if (body.orientation) merged.orientation = body.orientation;
      if (body.margins) merged.margins = { ...((doc.pageSetup && doc.pageSetup.margins) || {}), ...body.margins };
      await writeMeta(id, { pageSetup: merged });
      return sendJSON(res, 200, { ok: true, pageSetup: merged });
    }
    return sendJSON(res, 405, { error: "method not allowed" });
  }

  // ---- format transform — applies formatting commands to an HTML fragment ----
  // POST /api/format { html, cmd, value? } → { html }
  if (p === "/api/format" && method === "POST") {
    const body = await readJSON(req);
    const html = String(body.html || "");
    const cmd = String(body.cmd || "").toLowerCase();
    const val = body.value != null ? String(body.value) : null;
    if (!html || !cmd) return sendJSON(res, 400, { error: "html and cmd required" });
    let transformed;
    try { transformed = applyFormat(html, cmd, val); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    return sendJSON(res, 200, { html: transformed });
  }

  return sendJSON(res, 404, { error: "not found" });
}

// ---- static ----
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.resolve(PUBLIC, "." + rel);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden");
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, "not found");
    send(res, 200, buf, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/version" && req.method === "GET") sendVersionPage(res);
    else if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: String(e.message || e) });
  }
});

// ============================================================
// WebSocket (RFC 6455) — hand-rolled, no dependencies.
// Rooms are process-local and keyed by document id; they relay presence,
// document updates, and cursors between clients connected to this instance.
// ============================================================
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const rooms = new Map(); // docId -> Set<client>
const COLORS = ["#e91e63", "#2196f3", "#4caf50", "#ff9800", "#9c27b0", "#00bcd4", "#795548", "#607d8b"];
let clientSeq = 0;
dataLifecycle = createDataLifecycle({
  storage,
  isDocumentActive: (docId) => rooms.has(docId) && rooms.get(docId).size > 0,
  retentionMs: DATA_RETENTION_MS,
  maxVersions: MAX_VERSIONS,
  versionRetentionMs: VERSION_RETENTION_MS,
  warningPercent: DISK_WARNING_PERCENT,
  criticalPercent: DISK_CRITICAL_PERCENT,
});

async function cleanupClosedDocument(docId, expectedRev) {
  if (!dataLifecycle) return false;
  const removed = await dataLifecycle.cleanupAfterClose(docId, expectedRev);
  if (removed) legalAiSessions.delete(docId);
  return removed;
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
function wsSend(client, obj) {
  if (client.socket.destroyed) return;
  try { client.socket.write(encodeFrame(1, Buffer.from(JSON.stringify(obj)))); } catch {}
}
function roomUsers(docId) {
  const set = rooms.get(docId);
  if (!set) return [];
  return [...set].map((c) => ({ id: c.id, user: c.user, color: c.color }));
}
function broadcastLocal(docId, exceptClientId, obj) {
  const set = rooms.get(docId);
  if (!set) return;
  for (const c of set) if (c.id !== exceptClientId) wsSend(c, obj);
}
function broadcast(docId, exceptClient, obj) {
  const exceptClientId = exceptClient ? exceptClient.id : null;
  broadcastLocal(docId, exceptClientId, obj);
}
function leaveRoom(client) {
  const set = rooms.get(client.docId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    const docId = client.docId;
    rooms.delete(docId);
    void cleanupClosedDocument(docId).catch((error) => {
      console.error(`close cleanup failed for ${docId}:`, error.message);
    });
  }
  else broadcastLocal(client.docId, null, { type: "presence", users: roomUsers(client.docId) });
}
function closeRoom(docId) {
  const set = rooms.get(docId);
  if (!set) return;
  for (const c of set) { try { c.socket.destroy(); } catch {} }
  rooms.delete(docId);
}
async function handleMessage(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === "hello") {
    const docId = String(msg.docId || "");
    if (!validId(docId)) return;
    if (client.anonymous) {
      const doc = await readMeta(docId);
      if (doc && doc.integration === "legalai") {
        wsSend(client, { type: "error", error: "authentication required for this LegalAI document" });
        try { client.socket.destroy(); } catch {}
        return;
      }
    }
    // A scoped token's WS connection is only allowed into the one document
    // it was minted for — the raw upgrade handshake accepted any valid
    // scoped token (its target doc isn't known until this "hello"), so this
    // is where per-document enforcement actually happens.
    if (client.scopedPayload && client.scopedPayload.editorDocumentId !== docId) {
      wsSend(client, { type: "error", error: "token not valid for this document" });
      try { client.socket.destroy(); } catch {}
      return;
    }
    if (client.docId) leaveRoom(client);
    client.docId = docId;
    client.user = String(msg.user || "Guest").slice(0, 60);
    if (!rooms.has(docId)) rooms.set(docId, new Set());
    rooms.get(docId).add(client);
    wsSend(client, { type: "welcome", id: client.id, color: client.color, users: roomUsers(docId) });
    broadcastLocal(docId, client.id, { type: "presence", users: roomUsers(docId) });
    return;
  }
  if (!client.docId) return;
  const from = { id: client.id, user: client.user, color: client.color };
  if (msg.type === "update") {
    broadcast(client.docId, client, {
      type: "update", from, rev: msg.rev, title: msg.title, state: msg.state,
      pageSetup: msg.pageSetup, comments: msg.comments, trackChanges: msg.trackChanges,
    });
  } else if (msg.type === "cursor") {
    broadcast(client.docId, client, { type: "cursor", from, at: msg.at });
  }
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // The target document isn't known yet at handshake time (it arrives later
  // in the "hello" message), so any validly-signed credential — global token
  // or a scoped token for ANY document — passes here; per-document scoping
  // is enforced in handleMessage's "hello" case once the docId is known.
  const auth = authenticateRequest(req, url);
  if (url.pathname !== "/ws" || !auth.ok) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const client = {
    id: `u${++clientSeq}`, color: COLORS[clientSeq % COLORS.length], socket, docId: null, user: "Guest",
    scopedPayload: auth.scoped,
    anonymous: !!auth.anonymous,
  };
  let buf = Buffer.alloc(0);
  let fragments = [];

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_BODY)) { socket.destroy(); return; }
        len = Number(big); off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const un = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
      }
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 8) { // close
        try { socket.write(encodeFrame(8, Buffer.alloc(0))); } catch {}
        socket.destroy();
        return;
      }
      if (opcode === 9) { // ping -> pong
        try { socket.write(encodeFrame(10, payload)); } catch {}
        continue;
      }
      if (opcode === 10) continue; // pong
      if (opcode === 1 || opcode === 2 || opcode === 0) {
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments = [];
          void handleMessage(client, full.toString("utf8")).catch((e) => {
            console.error("websocket message failed:", e.message);
            try { client.socket.destroy(); } catch {}
          });
        }
      }
    }
  });
  const cleanup = () => { if (client.docId) leaveRoom(client); };
  socket.on("close", cleanup);
  socket.on("error", () => { cleanup(); try { socket.destroy(); } catch {} });
});

// keepalive pings
setInterval(() => {
  for (const set of rooms.values()) {
    for (const c of set) {
      try { c.socket.write(encodeFrame(9, Buffer.alloc(0))); } catch {}
    }
  }
}, 30000).unref();

if (LEGALAI_AUTO_COMMIT_ENABLED) {
  setInterval(async () => {
    for (const [id, session] of legalAiSessions) {
      if (!session.businessToken || session.committing) continue;
      try {
        const meta = await readMeta(id);
        if (meta && meta.rev !== session.lastCommittedRev) {
          await commitLegalAiDocument(id, session.businessToken, "timer");
        }
      } catch (e) {
        console.error(`LegalAI timed commit failed for ${id}:`, e.message);
      }
    }
  }, LEGALAI_AUTO_COMMIT_INTERVAL_MS).unref();
  console.log(`LegalAI timed commit enabled (${LEGALAI_AUTO_COMMIT_INTERVAL_MS} ms)`);
}

setInterval(() => {
  void dataLifecycle.runDailyCleanup().catch((error) => {
    console.error("daily data cleanup failed:", error.message);
  });
}, DATA_CLEANUP_INTERVAL_MS).unref();

setInterval(() => {
  void dataLifecycle.checkDiskUsage().catch((error) => {
    console.error("data disk usage check failed:", error.message);
  });
}, DISK_CHECK_INTERVAL_MS).unref();

async function startServer() {
  if (STARTUP_DRAFT_PURGE_ENABLED) await dataLifecycle.purgeDraftsAndHistoryOnStartup();
  await dataLifecycle.runDailyCleanup();
  await dataLifecycle.checkDiskUsage();
  server.listen(PORT, HOST, () => console.log(`word-editor on http://${HOST}:${PORT}`));
}

void startServer().catch((error) => {
  console.error("word-editor startup failed:", error);
  process.exitCode = 1;
});
