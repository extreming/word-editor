import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mintToken } from '../server/scopedAuth.js';

let base, child, data;
before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-prefix-'));
  fs.writeFileSync(path.join(data, 'contract-1.json'), JSON.stringify({
    id: 'contract-1', integration: 'legalai', updatedAt: Date.now(), state: '<p>contract</p>', rev: 1,
  }));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
      TOKEN_SECRET: '', BUSINESS_AUTO_COMMIT_ENABLED: 'false', STARTUP_DRAFT_PURGE_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('doc-editor on http://')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
});
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  if (data) fs.rmSync(data, { recursive: true, force: true });
});

test('pages, assets, API and version are available under the single prefix', async () => {
  for (const route of ['/', '/editor.html', '/js/sdk.js', '/js/main.js', '/css/app.css',
    '/api-docs.html', '/api-docs.css', '/embed-demo.html', '/api/health', '/version']) {
    const response = await fetch(`${base}/doc-editor${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    await response.arrayBuffer();
  }
  const html = await (await fetch(`${base}/doc-editor/editor.html`)).text();
  assert.match(html, /src="\/doc-editor\/js\/main.js"/);
  assert.match(html, /href="\/doc-editor\/css\/app.css"/);
  const redirect = await fetch(`${base}/doc-editor?embed=1&doc=contract-1`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/doc-editor/?embed=1&doc=contract-1');
  assert.equal((await fetch(`${base}/doc-editor-other/api/health`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('prefixed document routes retain scoped-token authorization', async () => {
  const url = `${base}/doc-editor/api/documents/contract-1`;
  assert.equal((await fetch(url)).status, 401);
  const secret = fs.readFileSync(path.join(data, '.token-secret'), 'utf8').trim();
  for (const [id, status] of [['contract-1', 200], ['another-contract', 401]]) {
    const { token } = mintToken(secret, { editorDocumentId: id });
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
});

test('prefixed WebSocket completes the upgrade and scoped document join', async () => {
  const secret = fs.readFileSync(path.join(data, '.token-secret'), 'utf8').trim();
  const { token } = mintToken(secret, { editorDocumentId: 'contract-1' });
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/doc-editor/ws?token=${encodeURIComponent(token)}`);
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', docId: 'contract-1', user: 'Prefix Test' }));
  const [event] = await message;
  const result = JSON.parse(event.data);
  assert.notEqual(result.type, 'error');
  const closed = once(socket, 'close');
  socket.close();
  await closed;
});

function sdkContext(scriptUrl) {
  const window = { addEventListener() {}, removeEventListener() {} };
  const holder = { appendChild(iframe) { this.iframe = iframe; } };
  const document = {
    currentScript: { src: scriptUrl }, querySelector: () => holder,
    createElement: () => ({ style: {}, remove() {} }),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/js/sdk.js', import.meta.url), 'utf8'), {
    window, document, location: new URL('https://frontend.example/review'), URL, URLSearchParams,
    setTimeout, clearTimeout, console,
  });
  return { window, holder };
}

test('SDK uses prefixed script base and preserves credentials only in the fragment', () => {
  for (const configured of [undefined, 'https://frontend.example', '/doc-editor', 'https://frontend.example/doc-editor/']) {
    const { window, holder } = sdkContext('https://frontend.example/doc-editor/js/sdk.js');
    const editor = window.DocEditor.init({ container: holder, baseUrl: configured,
      docId: 'contract-1', businessToken: 'private-token' });
    const url = new URL(holder.iframe.src);
    assert.equal(url.origin + url.pathname, 'https://frontend.example/doc-editor/');
    assert.equal(url.searchParams.get('doc'), 'contract-1');
    assert.equal(url.searchParams.has('businessToken'), false);
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('businessToken'), 'private-token');
    editor.destroy();
  }
});

test('REST client accepts both server origin and prefixed service URL without doubling', async () => {
  for (const input of ['https://editor.example', 'https://editor.example/doc-editor/']) {
    const requests = [];
    const window = {};
    vm.runInNewContext(fs.readFileSync(new URL('../public/js/api-client.js', import.meta.url), 'utf8'), {
      window, URL, location: new URL('https://frontend.example/'),
      fetch: async url => {
        requests.push(url);
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => [] };
      },
    });
    await new window.DocEditorRestClient(input).listDocuments();
    assert.equal(requests[0], 'https://editor.example/doc-editor/api/documents');
  }
});
