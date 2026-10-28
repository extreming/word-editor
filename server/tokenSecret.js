"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Internal editor credential only; the business backend does not share it.
// The non-JSON filename keeps document lifecycle cleanup from touching the key.
function resolveTokenSecret(dataDir, configuredSecret = process.env.TOKEN_SECRET) {
  if (configuredSecret) return configuredSecret;

  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, ".token-secret");
  try {
    fs.writeFileSync(secretPath, crypto.randomBytes(32).toString("hex"), {
      flag: "wx", mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const secret = fs.readFileSync(secretPath, "utf8").trim();
  // Fail startup rather than silently replacing a damaged key.
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("Invalid editor token secret file; restore .token-secret or explicitly configure TOKEN_SECRET");
  }
  return secret;
}

module.exports = { resolveTokenSecret };
