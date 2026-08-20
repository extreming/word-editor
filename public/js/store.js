// store.js — backend API client, autosave with conflict detection, WebSocket sync.

const API = "/api/documents";

// Bearer credential for this session: either the server's global AUTH_TOKEN
// (server-to-server use) or a short-lived, document-scoped token minted via
// POST /api/auth/token. Set via ?token= in the editor URL, or — the
// preferred path for an embedded iframe, since a URL can leak through
// referrers/history/logs — via the postMessage SDK's setAuthToken command.
let authToken = null;
export function setAuthToken(token) { authToken = token || null; }
export function getAuthToken() { return authToken; }
let legalAiBusinessToken = null;
export function setLegalAiBusinessToken(token) { legalAiBusinessToken = token || null; }

export async function openLegalAiSession({ docId, businessToken, title, fileType, tenantId }) {
  legalAiBusinessToken = businessToken || null;
  const response = await fetch("/api/integrations/legalai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, businessToken, title, fileType, tenantId }),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error || ""; } catch {}
    throw new Error(detail || `LegalAI editor session failed (HTTP ${response.status})`);
  }
  const session = await response.json();
  setAuthToken(session.token);
  return session;
}

export async function commitLegalAiDocument(id, reason = "manual", keepalive = false) {
  if (!id || !legalAiBusinessToken) return { ok: true, skipped: "not-legalai" };
  const headers = { "Content-Type": "application/json", "X-LegalAI-Token": legalAiBusinessToken };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(`${API}/${encodeURIComponent(id)}/commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason }),
    keepalive,
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error || ""; } catch {}
    throw new Error(detail || `LegalAI commit failed (HTTP ${response.status})`);
  }
  return response.json();
}

async function req(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 409) {
    const body = await r.json();
    const err = new Error("conflict");
    err.conflict = true;
    err.current = body.current;
    throw err;
  }
  if (!r.ok) {
    // Surface the server's own error/hint (e.g. ".doc conversion
    // unavailable", "could not parse .docx: …") instead of a bare status
    // code — callers like the file-open handler alert() this message
    // directly, so a generic "HTTP 422" would leave the user no better off
    // than before the server started explaining what went wrong.
    let detail = "";
    try {
      const body = await r.json();
      detail = [body.error, body.hint].filter(Boolean).join(" — ");
    } catch {}
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function listDocuments() {
  try { return await req(API); } catch { return []; }
}
export function createDocument(title = "Untitled") {
  return req(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}
export async function getDocument(id) {
  try { return await req(`${API}/${id}`); } catch { return null; }
}
export function saveDocument(id, { title, state, pageSetup, comments, trackChanges, baseRev }) {
  return req(`${API}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, state, pageSetup, comments, trackChanges, baseRev }),
  });
}
export async function deleteDocument(id) {
  await req(`${API}/${id}`, { method: "DELETE" });
}
export async function putDocx(id, blob) {
  const b64 = await blobToBase64(blob);
  await req(`${API}/${id}/docx`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: b64 }),
  });
}
export async function importDocxFile(file) {
  const b64 = await blobToBase64(file);
  return req(`${API}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, data: b64 }),
  });
}
export async function listVersions(id) {
  try { return await req(`${API}/${id}/versions`); } catch { return []; }
}
export function getVersion(id, index) {
  return req(`${API}/${id}/versions/${index}`);
}
export function restoreVersion(id, index) {
  return req(`${API}/${id}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index }),
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------
// Autosave with optimistic concurrency
// ---------------------------------------------------------------
export class Autosaver {
  constructor(id, delayMs, onStatus, onSaved, onConflict) {
    this.id = id;
    this.rev = 0;
    this.delayMs = delayMs;
    this.onStatus = onStatus;
    this.onSaved = onSaved || (() => {});
    this.onConflict = onConflict || (() => {});
    this.timer = null;
    this.inFlight = false;
    this.flushPromise = null;
    this.lastError = null;
    this.dirty = false;
    this.pending = null;
    this.suspended = false;
  }
  setId(id, rev = 0) { this.id = id; this.rev = rev; this.dirty = false; this.pending = null; clearTimeout(this.timer); }
  setRev(rev) { this.rev = rev; }
  update(payload) {
    if (this.suspended) return;
    this.pending = payload;
    this.dirty = true;
    this.onStatus("saving");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
  }
  async flush() {
    if (this.suspended) return;
    if (this.inFlight && this.flushPromise) {
      await this.flushPromise;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.dirty || !this.pending) return;
    this.inFlight = true;
    this.dirty = false;
    const payload = this.pending;
    this.flushPromise = (async () => {
      try {
        const doc = await saveDocument(this.id, { ...payload, baseRev: this.rev });
        this.rev = doc.rev;
        this.lastError = null;
        this.onStatus("saved");
        this.onSaved(doc);
        return doc;
      } catch (e) {
        if (e.conflict) {
          this.onStatus("conflict");
          this.onConflict(e.current);
        } else {
          this.onStatus("error");
          this.dirty = true;
          this.lastError = e;
          return null;
        }
      } finally {
        this.inFlight = false;
      }
    })();
    try {
      return await this.flushPromise;
    } finally {
      this.flushPromise = null;
      if (this.dirty) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
      }
    }
  }
}

// ---------------------------------------------------------------
// Realtime sync client
// ---------------------------------------------------------------
export class SyncClient {
  constructor(user, handlers = {}) {
    this.user = user;
    this.handlers = handlers; // { onPresence(users), onUpdate(msg), onOpen(), onClose() }
    this.docId = null;
    this.ws = null;
    this.closedByUs = false;
    this.retry = 0;
  }
  join(docId) {
    this.docId = docId;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "hello", docId, user: this.user }));
    } else {
      this.connect();
    }
  }
  leave(docId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "leave", docId: docId || this.docId, user: this.user })); } catch {}
    }
    this.docId = null;
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUs = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      const qs = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
      this.ws = new WebSocket(`${proto}//${location.host}/ws${qs}`);
    } catch { return; }
    this.ws.addEventListener("open", () => {
      this.retry = 0;
      if (this.docId) this.ws.send(JSON.stringify({ type: "hello", docId: this.docId, user: this.user }));
      if (this.handlers.onOpen) this.handlers.onOpen();
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if ((msg.type === "presence" || msg.type === "welcome") && this.handlers.onPresence) {
        this.handlers.onPresence(msg.users || []);
      } else if (msg.type === "update" && this.handlers.onUpdate) {
        this.handlers.onUpdate(msg);
      }
    });
    this.ws.addEventListener("close", () => {
      if (this.handlers.onClose) this.handlers.onClose();
      if (!this.closedByUs && this.retry < 8) {
        this.retry++;
        setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** this.retry));
      }
    });
    this.ws.addEventListener("error", () => { try { this.ws.close(); } catch {} });
  }
  sendUpdate(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "update", ...payload })); } catch {}
    }
  }
  close() {
    this.closedByUs = true;
    if (this.ws) try { this.ws.close(); } catch {}
  }
}
