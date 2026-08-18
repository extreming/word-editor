"use strict";
// Short-lived, document-scoped bearer tokens (HMAC-signed, zero extra deps —
// built on Node's built-in crypto). Not a JWT implementation: fixed algorithm,
// fixed claim set, no external library, deliberately minimal.
//
// Format: "v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>"
// Payload: { tenantId, contractId, editorDocumentId, iat, exp }
//
// This is word-editor's own proposal for how LegalAI mints per-contract
// credentials (see POST /api/auth/token) — it is NOT tied to any auth scheme
// LegalAI's backend may already use elsewhere; treat it as a starting
// contract to confirm with them, not a fixed integration requirement.

const crypto = require("crypto");

const MIN_TTL = 60;          // 1 minute
const MAX_TTL = 60 * 60;     // 1 hour
const DEFAULT_TTL = 15 * 60; // 15 minutes

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuffer(str) {
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

function mintToken(secret, { tenantId, contractId, editorDocumentId, ttlSeconds } = {}) {
  const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL, MIN_TTL), MAX_TTL);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    tenantId: tenantId != null ? String(tenantId).slice(0, 200) : null,
    contractId: contractId != null ? String(contractId).slice(0, 200) : null,
    editorDocumentId: editorDocumentId != null ? String(editorDocumentId).slice(0, 200) : null,
    iat: now,
    exp: now + ttl,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sigB64 = b64url(hmac(secret, payloadB64));
  return { token: `v1.${payloadB64}.${sigB64}`, payload };
}

function verifyToken(secret, token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payloadB64, sigB64] = parts;
  const expectedSig = hmac(secret, payloadB64);
  let given;
  try { given = b64urlToBuffer(sigB64); } catch { return null; }
  if (given.length !== expectedSig.length || !crypto.timingSafeEqual(given, expectedSig)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8")); } catch { return null; }
  if (!payload || typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

module.exports = { mintToken, verifyToken, DEFAULT_TTL, MAX_TTL, MIN_TTL };
