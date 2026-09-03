const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// npm run test:browser. Requires Playwright and a Chromium browser.
// Set PLAYWRIGHT_MODULE_PATH and CHROME_PATH when the browser runtime is external.
// PDF coverage uses the same CDN dependencies as the real viewer.
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-regressions-'));
  let browser, child;
  try {
    // PORT=0 chooses a free port; print the actual address when the server starts.
    child = spawn(process.execPath, ['-e', `process.env.PORT='0';const http=require('http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};require('./server.js')`],
      { cwd: path.resolve(__dirname, '..'), windowsHide: true, env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1' } });
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', d => { const m = /TEST_PORT=(\d+)/.exec(String(d)); if (m) resolve(m[1]); });
      child.on('error', reject); child.on('exit', code => reject(new Error('Server exited: ' + code)));
      child.stderr.on('data', d => process.stderr.write(d));
    });
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/editor.html?locale=en');
    await page.waitForSelector('#editor[contenteditable=true]');
    await page.waitForFunction(() => document.querySelector('#doc-info').textContent.includes('rev'));
    const setContent = async (html, selector = 'p', offset = null) => {
      await page.evaluate(async ({html, selector, offset}) => {
        const m = await import('/js/editor.js'), editor = document.querySelector('#editor');
        editor.innerHTML = html; editor.focus();
        const target = editor.querySelector(selector) || editor;
        const r = document.createRange(); r.selectNodeContents(target);
        if (offset !== null) r.setStart(target.firstChild, Math.min(offset, target.firstChild.length ?? target.firstChild.childNodes.length));
        r.collapse(offset !== null);
        getSelection().removeAllRanges(); getSelection().addRange(r); m.saveSelection(editor);
        editor.dispatchEvent(new InputEvent('input', {bubbles:true}));
      }, {html, selector, offset});
      await page.waitForTimeout(250);
      await page.evaluate(() => { document.querySelector('#editor-wrap').scrollTop = 0; });
    };
    const table = '<table><tbody>' + '<tr><td>A</td><td>B</td><td>C</td></tr>'.repeat(3) + '</tbody></table><p><br></p>';
    for (const [name, selector] of [['Del col', 'tr:first-child td'], ['Del row', 'tr']]) {
      await setContent(table, 'td');
      for (let left = 2; left >= 0; left--) {
        await page.getByRole('button', { name, exact: true }).click();
        assert.equal(await page.locator('#editor table ' + selector).count(), left);
      }
      assert.equal(await page.locator('#editor table').count(), 0);
      await page.keyboard.type('after delete');
      assert.match(await page.locator('#editor').innerText(), /after delete/);
    }
    await setContent(table, 'td');
    await page.getByRole('button', {name:'Del table',exact:true}).click();
    assert.equal(await page.locator('#editor table').count(), 0);
    console.log('PASS continuous row/column deletion and delete table');

    await setContent('<table><tbody><tr><td rowspan="2">Merged</td><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>', 'tr:nth-child(2) td');
    await page.getByRole('button', {name:'Del col',exact:true}).click();
    assert.equal(await page.locator('#editor table').innerText(), 'Merged\tB\nD');
    await setContent('<table><tbody><tr><td rowspan="2">Keep me</td><td>A</td></tr><tr><td>B</td></tr></tbody></table>', 'td');
    await page.getByRole('button', {name:'Del row',exact:true}).click();
    assert.match(await page.locator('#editor table').innerText(), /Keep me\tB/);
    console.log('PASS merged cell deletion preserves the correct column and content');

    for (const [html, selector] of [['<p>BeforeAfter</p>','p'], [table,'td'], ['<blockquote><p>BeforeAfter</p></blockquote>','p']]) {
      await setContent(html, selector, 3);
      await page.click('#btn-insert'); await page.click('[data-ins=pagebreak]');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#editor > .page-break').count(), 1);
      assert.equal(await page.locator('.page-gap').count(), 1);
      await page.keyboard.press('Control+z');
      assert.equal(await page.locator('#editor > .page-break').count(), 0);
    }
    await setContent('<p>BeforeAfter</p>', 'p', 6);
    await page.click('#btn-insert'); await page.click('[data-ins=blankpage]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.page-gap').count(), 2);
    await page.keyboard.type('Blank page text');
    const landing = await page.evaluate(() => { const e = document.querySelector('#editor'); const p = [...e.children].find(n => n.textContent.includes('Blank page text')); return {html:e.innerHTML,top:p.getBoundingClientRect().top-e.getBoundingClientRect().top}; });
    assert.ok(landing.top > 1000 && landing.top < 1200, JSON.stringify(landing));
    console.log('PASS menu page breaks in paragraphs, nested blocks and tables; blank-page caret');
    await setContent('<p>End</p>', 'p');
    await page.click('#btn-insert'); await page.click('[data-ins=blankpage]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.page-gap').count(), 1, 'a blank page at document end must not create a third empty sheet');

    const generated = await page.evaluate(async () => (await import('/js/editor.js')).tableHtml(3, 3));
    await setContent(generated, 'td');
    let box = await page.locator('#editor td').first().boundingBox();
    assert.ok(box.height >= 40 && box.width > 150);
    const startWidth = box.width;
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width + 48, box.y + box.height / 2, {steps:5}); await page.mouse.up();
    await page.waitForTimeout(300);
    box = await page.locator('#editor td').first().boundingBox();
    assert.ok(box.width > startWidth + 30, JSON.stringify({startWidth,box}));
    const startHeight = box.height;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height + 38, {steps:5}); await page.mouse.up();
    await page.waitForTimeout(300);
    box = await page.locator('#editor td').first().boundingBox();
    assert.ok(box.height > startHeight + 25);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('#save-status').classList.contains('saved'));
    await page.reload(); await page.waitForSelector('#editor td');
    assert.match(await page.locator('#editor tr').first().getAttribute('style'), /height:/);
    console.log('PASS default table size, drag column and row, save/reload dimensions');

    for (const zoom of ['0.75', '1.5']) {
      await page.selectOption('#zoom', zoom);
      await setContent(generated, 'td');
      const before = await page.locator('#editor td').first().boundingBox();
      await page.mouse.move(before.x + before.width - 2, before.y + before.height / 2);
      await page.mouse.down(); await page.mouse.move(before.x + before.width + 28, before.y + before.height / 2, {steps:4}); await page.mouse.up();
      const after = await page.locator('#editor td').first().boundingBox();
      assert.ok(Math.abs(after.width - before.width - 30) < 4, JSON.stringify({zoom,before,after}));
    }
    await page.selectOption('#zoom', '1');
    console.log('PASS table resize at 75% and 150% zoom');

    const response = await page.request.post(base + '/api/documents', {data:{ title:'Reply regression', state:'<p><span class="comment-ref" data-cid="c1">Anchor</span></p>', comments:[{id:'c1',author:'Alice',text:'Review this',createdAt:1700000000000,replies:[]}] }});
    const doc = await response.json(); assert.ok(doc.id, JSON.stringify(doc));
    const seeded = await page.request.put(base + '/api/documents/' + doc.id, {data:{state:doc.state, comments:[{id:'c1',author:'Alice',text:'Review this',createdAt:1700000000000,replies:[]}]}});
    assert.ok(seeded.ok());
    await page.goto(base + '/editor.html?locale=en&doc=' + doc.id);
    await page.waitForSelector('#editor .comment-ref'); await page.click('#btn-comments');
    await page.getByRole('button',{name:'Reply',exact:true}).click();
    await page.locator('.comment-reply-input').fill('Saved with button');
    await page.getByRole('button',{name:'Save reply',exact:true}).click();
    await page.getByRole('button',{name:'Reply',exact:true}).click();
    await page.locator('.comment-reply-input').fill('Saved with Ctrl+S');
    await page.getByRole('button',{name:'Reply',exact:true}).click();
    assert.equal(await page.locator('.comment-reply-input').count(), 1);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('#save-status').classList.contains('saved'));
    await page.reload(); await page.waitForSelector('#editor .comment-ref');
    if (!(await page.locator('#comments-panel').isVisible())) await page.click('#btn-comments');
    const replies = await page.locator('.comment-reply').allTextContents();
    assert.equal(replies.length, 2);
    assert.ok(replies[0].endsWith('Saved with button'));
    assert.ok(replies[1].endsWith('Saved with Ctrl+S'));
    console.log('PASS reply button and Ctrl+S persistence');

    // Minimal valid one-page PDF; the real viewer loads its normal pdf.js CDN dependency.
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, body] of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'].entries()) {
      offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    }
    const startXref = Buffer.byteLength(pdf);
    pdf += 'xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;
    await page.evaluate(async bytes => {
      await (await import('/js/pdf-view.js')).openPdf(new File([new Uint8Array(bytes)], 'regression.pdf', {type:'application/pdf'}));
    }, [...Buffer.from(pdf)]);
    await page.waitForSelector('.pdf-page-wrap canvas');
    await page.locator('#pdf-toolbar button[title="Add comment"], #pdf-toolbar button[data-tip="Add comment"]').click();
    page.once('dialog', d => d.accept('A long comment '.repeat(30)));
    await page.locator('.pdf-page-wrap canvas').click({position:{x:200,y:160}});
    await page.waitForSelector('.ann-comment');
    const hitChecks = await page.locator('.ann-comment').evaluate(ann => {
      const visible = selector => {
        const node = ann.querySelector(selector), rect = node.getBoundingClientRect();
        return [[rect.width/2,2],[rect.width-2,rect.height/2],[2,rect.height/2],[rect.width/2,rect.height-2]].every(([x,y]) => {
          const hit = document.elementFromPoint(rect.x + x, rect.y + y);
          return hit === node || node.contains(hit);
        });
      };
      return {close:visible('.ann-del'),resize:visible('.ann-resize'),textClipped:getComputedStyle(ann.querySelector('.ann-text')).overflow === 'hidden'};
    });
    if (process.env.REGRESSION_SCREENSHOT) await page.screenshot({path:process.env.REGRESSION_SCREENSHOT});
    assert.deepEqual(hitChecks, {close:true,resize:true,textClipped:true});
    const annBefore = await page.locator('.ann-comment').boundingBox();
    const handle = await page.locator('.ann-resize').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + 60, handle.y + 40, {steps:5}); await page.mouse.up();
    const annAfter = await page.locator('.ann-comment').boundingBox();
    assert.ok(annAfter.width > annBefore.width + 25 && annAfter.height > annBefore.height + 15);
    if (process.env.REGRESSION_SCREENSHOT) await page.screenshot({path:process.env.REGRESSION_SCREENSHOT});
    await page.locator('.ann-del').click();
    assert.equal(await page.locator('.ann-comment').count(), 0);
    console.log('PASS real PDF comment controls: full hit areas, drag resize and close');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
    // dataDir is an isolated mkdtemp directory created by this test.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('doc-editor-regressions-'));
    fs.rmSync(dataDir, {recursive:true,force:true});
  }
})().catch(e => { console.error(e); process.exitCode=1; });
