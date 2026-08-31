import test from "node:test";
import assert from "node:assert/strict";

import { buildDocxFromHtml, importDocx, unzip, zip } from "../server/docxNode.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";

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
