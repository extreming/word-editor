import test from "node:test";
import assert from "node:assert/strict";

import { buildDocxFromHtml, importDocx, unzip, zip } from "../server/docxNode.mjs";
import { sanitizeHtml } from "../public/js/editor.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const V = "urn:schemas-microsoft-com:vml";

test("comment replies keep their author, text, timestamp and parent across DOCX saves", async () => {
  const comments = [{ id: 'thread', author: 'Alice', text: 'First line\nSecond line', createdAt: 1700000000000, resolved: true,
    replies: [{ author: 'Bob', text: 'Reply <one>\nNext line', createdAt: 1700000010000 },
      { author: '陈', text: '已确认', createdAt: 1700000020000 }] }];
  const blob = await buildDocxFromHtml('<p><span class="comment-ref" data-cid="thread">Anchor</span></p>', { comments });
  const buffer = await blob.arrayBuffer();
  const imported = await importDocx(buffer);
  assert.equal(imported.comments.length, 1);
  assert.deepEqual({ ...imported.comments[0], id: 'thread' }, comments[0]);
  const files = await unzip(buffer);
  const ex = new DOMParser().parseFromString(new TextDecoder().decode(files.get('word/commentsExtended.xml')), 'application/xml');
  const nodes = [...ex.documentElement.children];
  assert.equal(nodes[1].getAttribute('w15:paraIdParent'), nodes[0].getAttribute('w15:paraId'));
  const again = await buildDocxFromHtml(imported.html, { comments: imported.comments, baseDocx: buffer });
  const reopened = await importDocx(await again.arrayBuffer());
  assert.deepEqual(reopened.comments, imported.comments);
  const deleted = await buildDocxFromHtml('<p>Anchor</p>', { comments: [], baseDocx: buffer });
  assert.deepEqual((await importDocx(await deleted.arrayBuffer())).comments, []);
});

test("resized table column widths and row heights survive DOCX export and import", async () => {
  const blob = await buildDocxFromHtml('<table style="width:500px;table-layout:fixed"><tbody><tr style="height:72px"><td style="width:320px">Left</td><td style="width:180px">Right</td></tr></tbody></table>');
  const buffer = await blob.arrayBuffer();
  const files = await unzip(buffer);
  const xml = new TextDecoder().decode(files.get('word/document.xml'));
  assert.match(xml, /<w:gridCol w:w="4800"\/>/);
  assert.match(xml, /<w:gridCol w:w="2700"\/>/);
  assert.match(xml, /<w:trHeight w:val="1080" w:hRule="atLeast"\/>/);
  const imported = await importDocx(buffer);
  const doc = new DOMParser().parseFromString(imported.html, 'text/html');
  assert.equal(doc.querySelector('table').style.width, '500px');
  assert.equal(doc.querySelector('tr').style.height, '72px');
  assert.equal(doc.querySelector('td').style.width, '320px');
});

test("explicit blank pages retain their boundaries without accumulating empty paragraphs", async () => {
  let html = '<p>Before</p><p class="page-break"><br></p><p><br></p><p class="page-break"><br></p><p>After</p>';
  for (let i = 0; i < 2; i++) {
    const blob = await buildDocxFromHtml(html);
    html = (await importDocx(await blob.arrayBuffer())).html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    assert.equal(doc.querySelectorAll('.page-break').length, 2);
    assert.equal(doc.querySelectorAll('p').length, 5);
    assert.equal(doc.querySelector('p').textContent, 'Before');
    assert.equal(doc.querySelector('p:last-child').textContent, 'After');
  }
});

function assertChoiceNamespace(outputXml) {
  const output = new DOMParser().parseFromString(outputXml, "application/xml");
  const choice = output.getElementsByTagNameNS(MC, "Choice")[0];
  assert.ok(choice, "round-tripped document should retain mc:Choice");
  assert.equal(choice.getAttribute("Requires"), "wps");
  assert.equal(choice.lookupNamespaceURI("wps"), WPS);
  assert.match(outputXml, /<mc:Choice\b[^>]*\bxmlns:wps=/);
}

test("round-trip keeps namespaces referenced only by mc:Choice Requires", async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:wps="${WPS}">
      <w:body><w:p><w:r><mc:AlternateContent>
        <mc:Choice Requires="wps"><w:drawing><wps:wsp/></w:drawing></mc:Choice>
        <mc:Fallback><w:pict/></mc:Fallback>
      </mc:AlternateContent></w:r></w:p><w:sectPr/></w:body>
    </w:document>`;
  const source = await zip(new Map([
    ["word/document.xml", new TextEncoder().encode(documentXml)],
  ]));
  const sourceBuffer = await source.arrayBuffer();

  const imported = await importDocx(sourceBuffer);
  const roundTripped = await buildDocxFromHtml(imported.html, {
    baseDocx: sourceBuffer,
    pageSetup: imported.pageSetup,
  });
  const files = await unzip(await roundTripped.arrayBuffer());
  const outputXml = new TextDecoder().decode(files.get("word/document.xml"));
  assertChoiceNamespace(outputXml);
});

test("export repairs legacy data-ooxml with a missing Choice namespace", async () => {
  const legacyFragment = `<w:r xmlns:w="${W}"><mc:AlternateContent xmlns:mc="${MC}">
    <mc:Choice Requires="wps"><w:drawing><wps:wsp xmlns:wps="${WPS}"/></w:drawing></mc:Choice>
    <mc:Fallback><w:pict/></mc:Fallback>
  </mc:AlternateContent></w:r>`;
  const encoded = Buffer.from(legacyFragment, "utf8").toString("base64");
  const html = `<p><span class="ooxml-object" data-ooxml="${encoded}" contenteditable="false"></span></p>`;
  const result = await buildDocxFromHtml(html);
  const files = await unzip(await result.arrayBuffer());
  const outputXml = new TextDecoder().decode(files.get("word/document.xml"));

  assertChoiceNamespace(outputXml);
});

test("adjacent vertical merge groups do not leak rowspans into each other", async () => {
  const tc = (text, span, merge = "") => `<w:tc><w:tcPr>
    <w:gridSpan w:val="${span}"/>${merge}
    </w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="${W}"><w:body><w:tbl>
      <w:tblGrid>${"<w:gridCol w:w=\"900\"/>".repeat(10)}</w:tblGrid>
      <w:tr>${tc("Total", 6, '<w:vMerge w:val="restart"/>')}${tc("Lower", 4)}</w:tr>
      <w:tr>${tc("", 6, "<w:vMerge/>")}${tc("Upper", 4)}</w:tr>
      <w:tr>${tc("Terms", 10, '<w:vMerge w:val="restart"/>')}</w:tr>
      <w:tr>${tc("", 10, "<w:vMerge/>")}</w:tr>
    </w:tbl><w:sectPr/></w:body></w:document>`;
  const source = await zip(new Map([
    ["word/document.xml", new TextEncoder().encode(documentXml)],
  ]));

  const imported = await importDocx(await source.arrayBuffer());
  const html = new DOMParser().parseFromString(imported.html, "text/html");
  const rows = [...html.querySelectorAll("table > tbody > tr")];

  assert.equal(rows.length, 4);
  assert.equal(rows[0].cells[0].rowSpan, 2);
  assert.equal(rows[0].cells[0].colSpan, 6);
  assert.equal(rows[2].cells.length, 1);
  assert.equal(rows[2].cells[0].textContent, "Terms");
  assert.equal(rows[2].cells[0].rowSpan, 2);
  assert.equal(rows[2].cells[0].colSpan, 10);
});

test("simple anchored DrawingML lines render as preserved horizontal dividers", async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:wps="${WPS}" xmlns:a="${A}" xmlns:wp="${WP}">
      <w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>
        <wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>19050</wp:posOffset></wp:positionH>
          <wp:positionV relativeFrom="paragraph"><wp:posOffset>228600</wp:posOffset></wp:positionV>
          <wp:extent cx="5295900" cy="635"/><a:graphic><a:graphicData><wps:wsp><wps:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="5295900" cy="635"/></a:xfrm>
            <a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="9525">
              <a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:prstDash val="solid"/>
              <a:headEnd type="none"/><a:tailEnd type="none"/>
            </a:ln></wps:spPr></wps:wsp></a:graphicData></a:graphic>
        </wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p><w:sectPr/></w:body>
    </w:document>`;
  const source = await zip(new Map([
    ["word/document.xml", new TextEncoder().encode(documentXml)],
  ]));
  const sourceBuffer = await source.arrayBuffer();

  const imported = await importDocx(sourceBuffer);
  const html = new DOMParser().parseFromString(imported.html, "text/html");
  const object = html.querySelector(".ooxml-object.ooxml-line.ooxml-simple-line");
  const preview = object && object.querySelector(".ooxml-line-preview");
  assert.ok(preview, "simple line should have a visual divider preview");
  assert.equal(preview.style.width, "556px");
  assert.equal(preview.style.borderTopWidth, "1px");
  assert.equal(preview.style.borderTopStyle, "solid");
  assert.equal(preview.style.transform, "translate(2px,24px)");

  const roundTripped = await buildDocxFromHtml(imported.html, { baseDocx: sourceBuffer });
  const files = await unzip(await roundTripped.arrayBuffer());
  const outputXml = new TextDecoder().decode(files.get("word/document.xml"));
  assert.match(outputXml, /<a:prstGeom prst="line">/);
  assert.match(outputXml, /<a:srgbClr val="123456"\/>/);
});

test("HTML sanitizer retains generated horizontal-line preview styles", () => {
  const sanitized = sanitizeHtml(`<span class="ooxml-object ooxml-simple-line has-preview">
    <span class="ooxml-line-preview" style="width:556px;max-width:100%;border-top:1px solid #000000;transform:translate(2px,24px)"></span>
    <span class="ooxml-object-label">Horizontal line · read-only</span></span>`);
  const html = new DOMParser().parseFromString(sanitized, "text/html");
  const preview = html.querySelector(".ooxml-line-preview");
  assert.equal(preview.style.width, "556px");
  assert.equal(preview.style.maxWidth, "100%");
  assert.equal(preview.style.borderTop, "1px solid rgb(0, 0, 0)");
});

test("simple anchored VML text boxes render text and preserve their source XML", async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="${W}" xmlns:v="${V}"><w:body><w:p><w:r><w:pict>
      <v:shape type="#_x0000_t202" stroked="f" style="position:absolute;margin-left:254pt;` +
        `margin-top:-12.75pt;width:223pt;height:38.4pt">
        <v:textbox><w:txbxContent><w:p><w:pPr><w:jc w:val="right"/></w:pPr>
          <w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>协议编号：</w:t></w:r>
          <w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>______________</w:t></w:r>
        </w:p></w:txbxContent></v:textbox>
      </v:shape></w:pict></w:r></w:p><w:sectPr/></w:body></w:document>`;
  const source = await zip(new Map([
    ["word/document.xml", new TextEncoder().encode(documentXml)],
  ]));
  const sourceBuffer = await source.arrayBuffer();

  const imported = await importDocx(sourceBuffer);
  const html = new DOMParser().parseFromString(imported.html, "text/html");
  const object = html.querySelector(".ooxml-object.ooxml-textbox.ooxml-simple-textbox");
  const preview = object && object.querySelector(".ooxml-textbox-preview");
  assert.ok(preview, "simple VML text box should have a visual text preview");
  assert.equal(preview.textContent, "协议编号：______________");
  assert.ok(object.classList.contains("ooxml-vml-anchored"));
  assert.equal(object.style.left, "338.67px");
  assert.equal(object.style.top, "-17px");
  assert.equal(object.style.width, "297.33px");
  assert.equal(object.style.height, "51.2px");
  assert.ok(object.closest("p").classList.contains("ooxml-anchor-container"));
  assert.equal(preview.querySelector(".ooxml-textbox-paragraph").style.textAlign, "right");

  const roundTripped = await buildDocxFromHtml(imported.html, { baseDocx: sourceBuffer });
  const files = await unzip(await roundTripped.arrayBuffer());
  const outputXml = new TextDecoder().decode(files.get("word/document.xml"));
  assert.match(outputXml, /<v:shape\b[^>]*type="#_x0000_t202"/);
  assert.match(outputXml, /<w:t>协议编号：<\/w:t>/);
});
