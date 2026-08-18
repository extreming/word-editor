"use strict";
// Legacy .doc/.dot -> .docx conversion via LibreOffice headless (the
// `soffice` binary — see Dockerfile for the apt-get install). This is an
// optional system dependency: if soffice isn't on PATH, callers should catch
// the SOFFICE_UNAVAILABLE error and fall back to the "please convert
// manually" message rather than crash the request.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONVERT_TIMEOUT_MS = 60_000;
const AVAILABILITY_CHECK_TIMEOUT_MS = 5_000;

function sofficeBinary() {
  return process.env.SOFFICE_PATH || "soffice";
}

let _availabilityPromise = null;
function checkAvailability() {
  if (!_availabilityPromise) {
    _availabilityPromise = new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      let child;
      try {
        child = spawn(sofficeBinary(), ["--version"], { stdio: "ignore" });
      } catch {
        return done(false);
      }
      const timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, AVAILABILITY_CHECK_TIMEOUT_MS);
      child.on("error", () => { clearTimeout(timer); done(false); });
      child.on("exit", (code) => { clearTimeout(timer); done(code === 0); });
    });
  }
  return _availabilityPromise;
}

// Converts legacy .doc/.dot bytes to .docx bytes. Each call gets its own
// throwaway LibreOffice user profile dir (`-env:UserInstallation=...`) —
// concurrent soffice --headless invocations sharing one profile is a
// well-known source of hangs/corruption, so this avoids that entirely rather
// than serializing conversions through a lock.
async function convertToDocx(bytes, originalName) {
  const available = await checkAvailability();
  if (!available) {
    throw Object.assign(
      new Error("LibreOffice (soffice) is not installed on this server — legacy .doc conversion is unavailable."),
      { code: "SOFFICE_UNAVAILABLE" }
    );
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "docconv-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-profile-"));
  try {
    const ext = (String(originalName || "").match(/\.(docx?|dot x?)$/i) || [".doc"])[0].toLowerCase();
    const inPath = path.join(workDir, "input" + (ext === ".doc" || ext === ".dot" ? ext : ".doc"));
    fs.writeFileSync(inPath, bytes);
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const child = spawn(sofficeBinary(), [
        "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
        `-env:UserInstallation=file://${profileDir}`,
        "--convert-to", "docx", "--outdir", workDir, inPath,
      ], { stdio: "ignore" });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        done(reject, new Error("LibreOffice conversion timed out"));
      }, CONVERT_TIMEOUT_MS);
      child.on("error", (e) => { clearTimeout(timer); done(reject, e); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? done(resolve) : done(reject, new Error(`soffice exited with code ${code}`));
      });
    });
    const outPath = path.join(workDir, path.basename(inPath).replace(/\.[^.]+$/, "") + ".docx");
    if (!fs.existsSync(outPath)) throw new Error("LibreOffice did not produce an output file");
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

module.exports = { convertToDocx, checkAvailability };
