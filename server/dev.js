"use strict";

// Explicit local-development entry point; never used by the deployment server.
if (process.env.NODE_ENV === "production") {
  throw new Error("npm run dev disables TLS verification and cannot run in production");
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
console.warn("[dev] HTTPS certificate verification is disabled for local development.");
require("../server.js");
