import test from 'node:test';
import assert from 'node:assert/strict';
import { zip, importDocx, buildDocxFromHtml } from '../server/docxNode.mjs';
import { sanitizeHtml } from '../public/js/editor.js';

test('DOCX underlined blanks retain spaces through import and export', async () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>采购</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">        </w:t></w:r><w:r><w:t>公司</w:t></w:r></w:p></w:body></w:document>';
  const source = await zip(new Map([['word/document.xml', new TextEncoder().encode(xml)]]));
  let result = await importDocx(source);
  for (let round = 0; round < 2; round++) {
    const container = document.createElement('div');
    container.innerHTML = sanitizeHtml(result.html);
    assert.equal(container.textContent, '采购        公司');
    assert.equal(container.querySelector('u').textContent, '        ');
    assert.equal(container.querySelector('u span[style]').style.whiteSpace, 'pre-wrap');
    result = await importDocx(await buildDocxFromHtml(container.innerHTML));
  }
});
