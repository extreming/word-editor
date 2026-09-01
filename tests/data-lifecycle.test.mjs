import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStorage } = require("../server/storage.js");
const { createDataLifecycle, DAY_MS } = require("../server/dataLifecycle.js");

function fixture(nowValue = Date.UTC(2026, 8, 1, 0, 0, 0)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "word-editor-lifecycle-"));
  const storage = createStorage(dir);
  const logs = [];
  const lifecycle = createDataLifecycle({
    storage,
    now: () => nowValue,
    logger: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });
  return {
    dir,
    storage,
    lifecycle,
    logs,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function write(storage, key, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  await storage.writeFile(key, buffer);
}

test("version retention keeps at most 10 snapshots from the last three days", () => {
  const current = Date.UTC(2026, 8, 1, 0, 0, 0);
  const ctx = fixture(current);
  try {
    const versions = [
      { t: current - 4 * DAY_MS, rev: 1 },
      ...Array.from({ length: 12 }, (_, index) => ({ t: current - DAY_MS + index, rev: index + 2 })),
    ];
    const retained = ctx.lifecycle.pruneVersions(versions);
    assert.equal(retained.length, 10);
    assert.deepEqual(retained.map((version) => version.rev), Array.from({ length: 10 }, (_, index) => index + 4));
  } finally {
    ctx.cleanup();
  }
});

test("confirmed close removes all four files only after the room is empty", async () => {
  const current = Date.UTC(2026, 8, 1, 0, 0, 0);
  const ctx = fixture(current);
  let active = true;
  const lifecycle = createDataLifecycle({ storage: ctx.storage, now: () => current, isDocumentActive: () => active, logger: { log() {}, warn() {}, error() {} } });
  try {
    const meta = { id: "A", integration: "legalai", rev: 7, lastCommittedRev: 7, closeCommittedRev: 7, updatedAt: current };
    await write(ctx.storage, "A.json", meta);
    await write(ctx.storage, "A.docx", "current");
    await write(ctx.storage, "A.source.docx", "source");
    await write(ctx.storage, "A.versions.json", [{ t: current, rev: 7 }]);

    assert.equal(await lifecycle.cleanupAfterClose("A", 7), false);
    active = false;
    assert.equal(await lifecycle.cleanupAfterClose("A", 7), true);
    for (const key of ["A.json", "A.docx", "A.source.docx", "A.versions.json"]) {
      assert.equal(await ctx.storage.exists(key), false, key);
    }
    const audit = (await ctx.storage.readFile("cleanup-audit.log")).toString("utf8");
    assert.match(audit, /editor-close-committed-and-room-empty/);
    assert.match(audit, /"documentId":"A"/);
  } finally {
    ctx.cleanup();
  }
});

test("daily cleanup retains unconfirmed drafts for 24 hours then removes them", async () => {
  const current = Date.UTC(2026, 8, 2, 0, 0, 0);
  const ctx = fixture(current);
  try {
    await write(ctx.storage, "new.json", { id: "new", integration: "legalai", rev: 2, lastCommittedRev: 1, updatedAt: current - DAY_MS + 1 });
    await write(ctx.storage, "old.json", { id: "old", integration: "legalai", rev: 2, lastCommittedRev: 1, updatedAt: current - DAY_MS });
    await write(ctx.storage, "new.docx", "keep");
    await write(ctx.storage, "old.docx", "remove");

    await ctx.lifecycle.runDailyCleanup();
    assert.equal(await ctx.storage.exists("new.json"), true);
    assert.equal(await ctx.storage.exists("new.docx"), true);
    assert.equal(await ctx.storage.exists("old.json"), false);
    assert.equal(await ctx.storage.exists("old.docx"), false);
    const audit = (await ctx.storage.readFile("cleanup-audit.log")).toString("utf8");
    assert.match(audit, /unconfirmed-draft-retention-expired/);
  } finally {
    ctx.cleanup();
  }
});

test("startup removes draft payload and history but retains lifecycle metadata and DOCX", async () => {
  const current = Date.UTC(2026, 8, 1, 0, 0, 0);
  const ctx = fixture(current);
  try {
    await write(ctx.storage, "A.json", {
      id: "A", title: "Contract", integration: "legalai", state: "<p>draft</p>", comments: [{ text: "x" }],
      pageSetup: { size: "A4" }, trackChanges: true, rev: 3, lastCommittedRev: 2, updatedAt: current,
    });
    await write(ctx.storage, "A.docx", "current");
    await write(ctx.storage, "A.source.docx", "source");
    await write(ctx.storage, "A.versions.json", [{ t: current, rev: 2 }]);

    await ctx.lifecycle.purgeDraftsAndHistoryOnStartup();
    const retained = JSON.parse((await ctx.storage.readFile("A.json")).toString("utf8"));
    assert.equal("state" in retained, false);
    assert.equal("comments" in retained, false);
    assert.equal(retained.lastCommittedRev, 2);
    assert.equal(await ctx.storage.exists("A.versions.json"), false);
    assert.equal(await ctx.storage.exists("A.docx"), true);
    assert.equal(await ctx.storage.exists("A.source.docx"), true);
  } finally {
    ctx.cleanup();
  }
});

test("disk usage reports warning at 70 percent and critical at 85 percent", async () => {
  const entries = [];
  let usedBytes = 700;
  const storage = {
    appendFile: async (_key, buffer) => entries.push(JSON.parse(buffer.toString("utf8"))),
    diskUsage: async () => ({ totalBytes: 1000, freeBytes: 1000 - usedBytes, usedBytes }),
  };
  const lifecycle = createDataLifecycle({ storage, logger: { log() {}, warn() {}, error() {} } });
  assert.equal((await lifecycle.checkDiskUsage()).level, "warning");
  usedBytes = 850;
  assert.equal((await lifecycle.checkDiskUsage()).level, "critical");
  assert.deepEqual(entries.map((entry) => entry.level), ["warning", "critical"]);
});
