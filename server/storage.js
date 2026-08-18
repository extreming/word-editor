"use strict";
// Storage abstraction: local disk (default, current behavior) or an
// S3-compatible object store, selected via STORAGE_DRIVER=local|s3.
//
// The S3 driver hand-signs requests with AWS Signature Version 4 using only
// Node's built-in crypto/http/https — no aws-sdk. It talks path-style
// (endpoint/bucket/key), which is what MinIO and most S3-compatible
// providers expect when given a custom endpoint.
//
// This exists for multi-instance deployment: local disk only works when a
// single instance (or a shared volume) owns the data directory, which is
// fine for a single-replica pilot but not once word-editor runs as N
// horizontally-scaled replicas behind a load balancer.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const DRIVER = (process.env.STORAGE_DRIVER || "local").toLowerCase();

// ---------------- local disk driver ----------------
function makeLocalDriver(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = (key) => path.join(dataDir, key);
  return {
    kind: "local",
    async readFile(key) {
      try { return fs.readFileSync(p(key)); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    },
    async writeFile(key, buf) { fs.writeFileSync(p(key), buf); },
    async deleteFile(key) { try { fs.unlinkSync(p(key)); } catch (e) { if (e.code !== "ENOENT") throw e; } },
    async exists(key) { return fs.existsSync(p(key)); },
    async listKeys(suffix) {
      return fs.readdirSync(dataDir).filter((f) => !suffix || f.endsWith(suffix));
    },
  };
}

// ---------------- S3-compatible driver (hand-signed SigV4) ----------------
function sha256hex(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function hmac(key, data) { return crypto.createHmac("sha256", key).update(data).digest(); }
const EMPTY_SHA256 = sha256hex(Buffer.alloc(0));

function makeS3Driver(opts) {
  const endpoint = new URL(opts.endpoint);
  const bucket = opts.bucket;
  const region = opts.region || "us-east-1";
  const accessKey = opts.accessKeyId;
  const secretKey = opts.secretAccessKey;
  const mod = endpoint.protocol === "https:" ? https : http;

  function amzDate() {
    const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amzDate: iso, dateStamp: iso.slice(0, 8) };
  }
  function canonicalUri(key) {
    // path-style: /<bucket>/<key>, each segment percent-encoded per SigV4 rules
    const segs = `${bucket}/${key}`.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()));
    return "/" + segs.join("/");
  }
  async function request(method, key, { query = "", body = null, extraHeaders = {} } = {}) {
    const { amzDate: xAmzDate, dateStamp } = amzDate();
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA256;
    const uri = canonicalUri(key);
    const headers = {
      host: endpoint.host,
      "x-amz-date": xAmzDate,
      "x-amz-content-sha256": payloadHash,
      ...extraHeaders,
    };
    if (body) headers["content-length"] = String(body.length);
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      method, uri, query, canonicalHeaders, signedHeaders, payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256", xAmzDate, credentialScope, sha256hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return new Promise((resolve, reject) => {
      const req = mod.request({
        protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port,
        path: uri + (query ? `?${query}` : ""), method,
        headers: { ...headers, Authorization: authorization },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      if (body) req.end(body); else req.end();
    });
  }

  return {
    kind: "s3",
    async readFile(key) {
      const res = await request("GET", key);
      if (res.status === 404) return null;
      if (res.status >= 300) throw new Error(`s3 GET ${key} failed: ${res.status} ${res.body.toString().slice(0, 300)}`);
      return res.body;
    },
    async writeFile(key, buf) {
      const res = await request("PUT", key, { body: buf });
      if (res.status >= 300) throw new Error(`s3 PUT ${key} failed: ${res.status} ${res.body.toString().slice(0, 300)}`);
    },
    async deleteFile(key) {
      const res = await request("DELETE", key);
      if (res.status >= 300 && res.status !== 404) throw new Error(`s3 DELETE ${key} failed: ${res.status}`);
    },
    async exists(key) {
      const res = await request("HEAD", key);
      return res.status === 200;
    },
    async listKeys(suffix) {
      // ListObjectsV2 — minimal XML key extraction (no full XML parser needed
      // for this one well-known, predictable response shape).
      let keys = [];
      let token = "";
      for (;;) {
        const q = new URLSearchParams({ "list-type": "2" });
        if (token) q.set("continuation-token", token);
        const res = await request("GET", "", { query: q.toString().replace(/\+/g, "%20") });
        if (res.status >= 300) throw new Error(`s3 LIST failed: ${res.status}`);
        const xml = res.body.toString("utf8");
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXmlEntities(m[1]));
        const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        const nextToken = (xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) || [])[1];
        if (!isTruncated || !nextToken) break;
        token = nextToken;
      }
      return suffix ? keys.filter((k) => k.endsWith(suffix)) : keys;
    },
    async ensureBucket() {
      const res = await request("PUT", "");
      if (res.status >= 300 && res.status !== 409) { // 409 = already owned by you
        throw new Error(`s3 create bucket failed: ${res.status} ${res.body.toString().slice(0, 300)}`);
      }
    },
  };
}
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function createStorage(dataDir) {
  if (DRIVER === "s3") {
    const required = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=s3 requires env vars: ${missing.join(", ")}`);
    return makeS3Driver({
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    });
  }
  return makeLocalDriver(dataDir);
}

module.exports = { createStorage };
