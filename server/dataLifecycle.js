"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const DOCUMENT_FILES = [
  (id) => `${id}.json`,
  (id) => `${id}.docx`,
  (id) => `${id}.source.docx`,
  (id) => `${id}.versions.json`,
];

function createDataLifecycle({
  storage,
  isDocumentActive = () => false,
  now = () => Date.now(),
  logger = console,
  retentionMs = DAY_MS,
  maxVersions = 10,
  versionRetentionMs = 3 * DAY_MS,
  auditFile = "cleanup-audit.log",
  warningPercent = 70,
  criticalPercent = 85,
} = {}) {
  let lastDiskLevel = "normal";
  const documentCleanups = new Map();

  function isoOrNull(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  async function audit(entry) {
    const record = { timestamp: new Date(now()).toISOString(), ...entry };
    await storage.appendFile(auditFile, Buffer.from(`${JSON.stringify(record)}\n`));
    logger.log("word-editor data lifecycle", record);
    return record;
  }

  async function readJson(key) {
    const buffer = await storage.readFile(key);
    if (!buffer) return null;
    try { return JSON.parse(buffer.toString("utf8")); } catch { return null; }
  }

  async function removeKeys(docId, keys, reason, lastUpdatedAt) {
    let releasedBytes = 0;
    const removedFiles = [];
    for (const key of keys) {
      const stat = await storage.statFile(key);
      if (!stat) continue;
      await storage.deleteFile(key);
      releasedBytes += stat.size;
      removedFiles.push(key);
    }
    if (removedFiles.length) {
      await audit({
        event: "cleanup",
        documentId: docId,
        lastUpdatedAt: isoOrNull(lastUpdatedAt),
        reason,
        releasedBytes,
        removedFiles,
      });
    }
    return { releasedBytes, removedFiles };
  }

  async function removeDocument(docId, reason, meta) {
    if (documentCleanups.has(docId)) return documentCleanups.get(docId);
    const cleanup = removeKeys(docId, DOCUMENT_FILES.map((key) => key(docId)), reason, meta?.updatedAt);
    documentCleanups.set(docId, cleanup);
    try {
      return await cleanup;
    } finally {
      documentCleanups.delete(docId);
    }
  }

  function pruneVersions(versions) {
    const cutoff = now() - versionRetentionMs;
    return versions
      .filter((version) => Number(version?.t) >= cutoff)
      .slice(-maxVersions);
  }

  async function pruneDocumentVersions(docId, meta) {
    const key = `${docId}.versions.json`;
    const originalBuffer = await storage.readFile(key);
    if (!originalBuffer) return false;
    let versions;
    try { versions = JSON.parse(originalBuffer.toString("utf8")); } catch { return false; }
    if (!Array.isArray(versions)) return false;
    const retained = pruneVersions(versions);
    if (retained.length === versions.length) return false;
    const nextBuffer = Buffer.from(JSON.stringify(retained));
    await storage.writeFile(key, nextBuffer);
    await audit({
      event: "cleanup",
      documentId: docId,
      lastUpdatedAt: isoOrNull(meta?.updatedAt),
      reason: "history-retention",
      releasedBytes: Math.max(originalBuffer.length - nextBuffer.length, 0),
      removedVersions: versions.length - retained.length,
    });
    return true;
  }

  async function cleanupAfterClose(docId, expectedRev) {
    if (isDocumentActive(docId)) return false;
    const meta = await readJson(`${docId}.json`);
    if (!meta) return false;
    const closeRev = Number(expectedRev ?? meta.closeCommittedRev);
    if (!closeRev || closeRev !== Number(meta.rev) || closeRev !== Number(meta.lastCommittedRev)) return false;
    await removeDocument(docId, "editor-close-committed-and-room-empty", meta);
    return true;
  }

  async function runDailyCleanup() {
    const keys = (await storage.listKeys(".json")).filter((key) => !key.endsWith(".versions.json"));
    const cutoff = now() - retentionMs;
    for (const key of keys) {
      const docId = key.slice(0, -".json".length);
      const meta = await readJson(key);
      if (!meta || isDocumentActive(docId)) continue;
      await pruneDocumentVersions(docId, meta);
      if (meta.integration !== "legalai") continue;
      const stat = await storage.statFile(key);
      const updatedAt = Number.isFinite(Number(meta.updatedAt)) ? Number(meta.updatedAt) : stat?.mtimeMs;
      if (!updatedAt || updatedAt > cutoff) continue;
      const committed = Number(meta.lastCommittedRev) === Number(meta.rev);
      await removeDocument(
        docId,
        committed ? "legalai-committed-idle-retention" : "unconfirmed-draft-retention-expired",
        meta,
      );
    }
  }

  async function purgeDraftsAndHistoryOnStartup() {
    const keys = (await storage.listKeys(".json")).filter((key) => !key.endsWith(".versions.json"));
    for (const key of keys) {
      const docId = key.slice(0, -".json".length);
      const meta = await readJson(key);
      if (!meta) {
        await removeKeys(docId, [key, `${docId}.versions.json`], "service-startup-corrupt-draft-purge", null);
        continue;
      }
      const before = await storage.statFile(key);
      const lifecycleMeta = { ...meta };
      delete lifecycleMeta.state;
      delete lifecycleMeta.comments;
      delete lifecycleMeta.pageSetup;
      delete lifecycleMeta.trackChanges;
      const nextBuffer = Buffer.from(JSON.stringify(lifecycleMeta));
      await storage.writeFile(key, nextBuffer);
      const versionKey = `${docId}.versions.json`;
      const versionStat = await storage.statFile(versionKey);
      if (versionStat) await storage.deleteFile(versionKey);
      const releasedBytes = Math.max((before?.size || 0) - nextBuffer.length, 0) + (versionStat?.size || 0);
      if (releasedBytes > 0) {
        await audit({
          event: "cleanup",
          documentId: docId,
          lastUpdatedAt: isoOrNull(meta.updatedAt),
          reason: "service-startup-draft-and-history-purge",
          releasedBytes,
          removedFiles: versionStat ? [versionKey] : [],
          scrubbedFiles: [key],
        });
      }
    }
    // Remove orphan history files even when their metadata is missing/corrupt.
    const remainingVersions = await storage.listKeys(".versions.json");
    for (const key of remainingVersions) {
      const docId = key.slice(0, -".versions.json".length);
      await removeKeys(docId, [key], "service-startup-orphan-history-purge", null);
    }
  }

  async function checkDiskUsage() {
    const usage = await storage.diskUsage();
    const usedPercent = usage.totalBytes > 0 ? (usage.usedBytes / usage.totalBytes) * 100 : 0;
    const level = usedPercent >= criticalPercent ? "critical" : usedPercent >= warningPercent ? "warning" : "normal";
    if (level !== "normal" && level !== lastDiskLevel) {
      const entry = {
        event: "disk-usage-alert",
        level,
        usedPercent: Number(usedPercent.toFixed(2)),
        usedBytes: usage.usedBytes,
        freeBytes: usage.freeBytes,
        totalBytes: usage.totalBytes,
        warningPercent,
        criticalPercent,
      };
      await audit(entry);
      const message = `word-editor data disk ${level}: ${entry.usedPercent}% used`;
      if (level === "critical") logger.error(message, entry);
      else logger.warn(message, entry);
    }
    if (level === "normal" && lastDiskLevel !== "normal") {
      await audit({ event: "disk-usage-recovered", level, usedPercent: Number(usedPercent.toFixed(2)) });
    }
    lastDiskLevel = level;
    return { ...usage, usedPercent, level };
  }

  return {
    cleanupAfterClose,
    checkDiskUsage,
    pruneDocumentVersions,
    pruneVersions,
    purgeDraftsAndHistoryOnStartup,
    removeDocument,
    runDailyCleanup,
  };
}

module.exports = { createDataLifecycle, DAY_MS };
