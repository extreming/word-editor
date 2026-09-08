import test from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip, importDocx, buildDocxFromHtml, refreshDocxNumbering } from '../server/docxNode.mjs';
import { sanitizeHtml } from '../public/js/editor.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const paragraph = (level, text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
async function fixture({ legal = true, override = '', restart = '' } = {}) {
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/><w:suff w:val="space"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/>${restart}${legal ? '<w:isLgl/>' : ''}<w:lvlText w:val="%1.%2"/><w:suff w:val="space"/></w:lvl>
    </w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/>${override}</w:num></w:numbering>`;
  const body = paragraph(0, '协议标的') + paragraph(1, '采购公司')
    + '<w:p><w:r><w:t>间隔段落</w:t></w:r></w:p>' + paragraph(1, '交付')
    + paragraph(0, '价格') + paragraph(1, '金额');
  return zip(new Map([['word/document.xml', new TextEncoder().encode(`<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`)],
    ['word/numbering.xml', new TextEncoder().encode(numbering)]]));
}
function container(html) {
  const el = document.createElement('div');
  el.innerHTML = sanitizeHtml(html);
  refreshDocxNumbering(el);
  return el;
}
const labels = (el) => [...el.querySelectorAll('li')].map(li => li.style.listStyleType);

test('Chinese article and legal multilevel numbers survive sanitize, save and DOCX round trips', async () => {
  let result = await importDocx(await fixture());
  for (let i = 0; i < 3; i++) {
    const el = container(result.html);
    assert.deepEqual(labels(el), ['"第一条 "', '"1.1 "', '"1.2 "', '"第二条 "', '"2.1 "']);
    assert.equal(el.textContent, '协议标的采购公司间隔段落交付价格金额');
    const exported = await buildDocxFromHtml(el.innerHTML);
    const files = await unzip(await exported.arrayBuffer());
    const xml = new TextDecoder().decode(files.get('word/numbering.xml'));
    assert.match(xml, /chineseCounting/);
    assert.match(xml, /第%1条/);
    assert.match(xml, /%1\.%2/);
    assert.match(xml, /isLgl/);
    result = await importDocx(exported);
  }
});

test('inserting and deleting a child item updates following numbers', async () => {
  const el = container((await importDocx(await fixture())).html);
  const firstChild = el.querySelectorAll('li')[1];
  const added = document.createElement('li');
  added.textContent = '新增内容';
  firstChild.after(added);
  refreshDocxNumbering(el);
  assert.deepEqual(labels(el), ['"第一条 "', '"1.1 "', '"1.2 "', '"1.3 "', '"第二条 "', '"2.1 "']);
  added.remove();
  refreshDocxNumbering(el);
  assert.deepEqual(labels(el), ['"第一条 "', '"1.1 "', '"1.2 "', '"第二条 "', '"2.1 "']);
});

test('without isLgl parent placeholders use the parent number format', async () => {
  const el = container((await importDocx(await fixture({ legal: false }))).html);
  assert.equal(labels(el)[1], '"一.1 "');
});

test('never-restart child levels continue across article boundaries and export', async () => {
  let result = await importDocx(await fixture({ restart: '<w:lvlRestart w:val="0"/>' }));
  for (let i = 0; i < 2; i++) {
    const el = container(result.html);
    assert.deepEqual(labels(el), ['"第一条 "', '"1.1 "', '"1.2 "', '"第二条 "', '"2.3 "']);
    result = await importDocx(await buildDocxFromHtml(el.innerHTML));
  }
});

test('start overrides persist and Chinese counting reaches ten', async () => {
  let result = await importDocx(await fixture({ override: '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride>' }));
  for (let i = 0; i < 2; i++) {
    const el = container(result.html);
    assert.deepEqual(labels(el), ['"第十条 "', '"10.1 "', '"10.2 "', '"第十一条 "', '"11.1 "']);
    result = await importDocx(await buildDocxFromHtml(el.innerHTML));
  }
});

test('ordinary decimal lists still use native automatic markers', async () => {
  const files = await unzip(await (await buildDocxFromHtml('<ol><li>A</li><li>B</li></ol>')).arrayBuffer());
  const numbering = new TextDecoder().decode(files.get('word/numbering.xml')).replace(/lowerLetter|lowerRoman/g, 'decimal');
  files.set('word/numbering.xml', new TextEncoder().encode(numbering));
  const result = await importDocx(await zip(files));
  assert.doesNotMatch(result.html, /data-ooxml-numbering/);
});
