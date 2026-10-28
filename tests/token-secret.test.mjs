import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolveTokenSecret } from '../server/tokenSecret.js';
import { mintToken, verifyToken } from '../server/scopedAuth.js';
import { createStorage } from '../server/storage.js';
import { createDataLifecycle } from '../server/dataLifecycle.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-token-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('automatic keys are random, persisted, and preserve signatures across reloads', t => {
  const dir = tempDir(t);
  const data = path.join(dir, 'nested');
  const key = resolveTokenSecret(data, '');
  assert.match(key, /^[a-f0-9]{64}$/);
  const token = mintToken(key, { editorDocumentId: 'contract-1' }).token;
  assert.equal(resolveTokenSecret(data, ''), key);
  assert.equal(verifyToken(resolveTokenSecret(data, ''), token).editorDocumentId, 'contract-1');
  assert.notEqual(resolveTokenSecret(path.join(dir, 'other'), ''), key);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(data, '.token-secret')).mode & 0o777, 0o600);
  }
});

test('explicit secret overrides files without creating or replacing them', t => {
  const dir = tempDir(t);
  assert.equal(resolveTokenSecret(dir, 'configured-secret'), 'configured-secret');
  assert.deepEqual(fs.readdirSync(dir), []);
  const generated = resolveTokenSecret(dir, '');
  assert.equal(resolveTokenSecret(dir, 'override'), 'override');
  assert.equal(resolveTokenSecret(dir, ''), generated);
});

test('corrupt or inaccessible secret storage fails instead of silently rotating', t => {
  const dir = tempDir(t);
  const keyPath = path.join(dir, '.token-secret');
  for (const content of ['', 'damaged']) {
    fs.writeFileSync(keyPath, content);
    assert.throws(() => resolveTokenSecret(dir, ''), /Invalid editor token secret file/);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), content);
  }
  assert.throws(() => resolveTokenSecret(keyPath, ''));
});

test('startup purge and daily document cleanup preserve the automatic key', async t => {
  const dir = tempDir(t);
  const key = resolveTokenSecret(dir, '');
  const storage = createStorage(dir);
  await storage.writeFile('expired.json', Buffer.from(JSON.stringify({
    id: 'expired', integration: 'legalai', updatedAt: 1, rev: 1, lastCommittedRev: 1,
  })));
  const lifecycle = createDataLifecycle({ storage, logger: { log() {} } });
  await lifecycle.purgeDraftsAndHistoryOnStartup();
  await lifecycle.runDailyCleanup();
  assert.equal(await storage.exists('expired.json'), false);
  assert.equal(resolveTokenSecret(dir, ''), key);
});

async function startEditor(t, dir, configuredSecret = '') {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir,
      TOKEN_SECRET: configuredSecret, BUSINESS_AUTO_COMMIT_ENABLED: 'false', STARTUP_DRAFT_PURGE_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  };
  t.after(stop);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('editor startup timeout')), 10000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('doc-editor on http://')) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`editor exited: ${output}`)); });
  });
  return { base: `http://127.0.0.1:${port}`, stop };
}

test('real server starts without configuration and accepts the same scoped token after restart', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'contract-1.json'), JSON.stringify({
    id: 'contract-1', integration: 'legalai', updatedAt: Date.now(), state: '<p>draft</p>', rev: 1,
  }));
  const first = await startEditor(t, dir);
  assert.equal((await fetch(`${first.base}/api/health`)).status, 200);
  const token = mintToken(fs.readFileSync(path.join(dir, '.token-secret'), 'utf8'), {
    editorDocumentId: 'contract-1',
  }).token;
  const request = (base, credential) => fetch(`${base}/api/documents/contract-1`, {
    headers: credential ? { Authorization: `Bearer ${credential}` } : {},
  });
  assert.equal((await request(first.base)).status, 401);
  assert.equal((await request(first.base, 'invalid')).status, 401);
  assert.equal((await request(first.base, token)).status, 200);
  await first.stop();
  const second = await startEditor(t, dir);
  assert.equal((await request(second.base, token)).status, 200);
  await second.stop();
  const third = await startEditor(t, dir, 'explicit-override');
  assert.equal((await request(third.base, token)).status, 401);
  const replacement = mintToken('explicit-override', { editorDocumentId: 'contract-1' }).token;
  assert.equal((await request(third.base, replacement)).status, 200);
  await third.stop();
});
