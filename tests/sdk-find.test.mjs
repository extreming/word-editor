import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createFindPanel, createSelectionHighlight, restoreSelection, saveSelection } from "../public/js/editor.js";
import { History } from "../public/js/history.js";

function setup(html) {
  const dom = new JSDOM('<div id="editor-wrap"><div id="editor"></div></div><div id="find-host"></div>', {
    url: "http://localhost/", runScripts: "outside-only",
  });
  const { window } = dom;
  for (const key of ["window", "document", "NodeFilter", "InputEvent"])
    globalThis[key] = key === "window" ? window : window[key];
  window.Range.prototype.getBoundingClientRect = () => ({ top: 600, height: 20 });
  const editor = window.document.getElementById("editor");
  editor.innerHTML = html;
  const panel = createFindPanel(editor, window.document.getElementById("find-host"));
  // jsdom does not paint CSS highlights. Exercise the registry contract here;
  // actual browser rendering is a separate smoke check.
  window.CSS = { highlights: new Map() };
  window.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
  return { dom, window, editor, panel, highlight: createSelectionHighlight(editor) };
}

test("SDK find selects across inline styles without changing HTML and saves its range", () => {
  const { dom, window, editor, panel } = setup('<p style="color:red">a <b>Hel</b><i>lo</i> world Hello</p>');
  const original = editor.innerHTML;
  assert.equal(panel.find("hello"), 2);
  assert.equal(editor.innerHTML, original);
  assert.equal(window.getSelection().toString(), "Hello");
  assert.ok(editor.parentElement.scrollTop > 0);
  window.getSelection().removeAllRanges();
  restoreSelection(editor);
  assert.equal(window.getSelection().toString(), "Hello");
  // This is the same native selection consumed by subsequent insertion APIs.
  const selected = window.getSelection().getRangeAt(0);
  selected.deleteContents();
  selected.insertNode(document.createTextNode("replacement"));
  assert.equal(editor.textContent, "a replacement world Hello");
  dom.window.close();
});

test("find preserves case/regex counts, ignores zero-length matches and block crossings", () => {
  const { dom, panel, editor } = setup("<p>One one stone</p><p>two</p>");
  const original = editor.innerHTML;
  assert.equal(panel.find("One", { matchCase: true }), 1);
  assert.equal(panel.find("\\bone\\b", { regex: true }), 2);
  assert.equal(panel.find("(?=one)", { regex: true }), 0);
  assert.equal(panel.find("[", { regex: true }), 0);
  assert.equal(panel.find(""), 0);
  assert.equal(panel.find("stonetwo"), 0);
  assert.equal(editor.innerHTML, original);
  dom.window.close();
});

test("panel navigation/replacement still works after an SDK find; manual search still highlights", () => {
  const { dom, window, editor, panel } = setup("<p>one one one</p>");
  panel.find("one");
  document.querySelectorAll("#find-panel button")[1].click();
  assert.equal(window.getSelection().getRangeAt(0).startOffset, 4);
  const inputs = document.querySelectorAll("#find-panel input");
  inputs[3].value = "two";
  document.querySelectorAll("#find-panel button")[2].click();
  assert.equal(editor.textContent, "one two one");
  assert.equal(panel.replaceAll("one", "three"), 2);
  assert.equal(editor.textContent, "three two three");
  inputs[0].value = "three";
  inputs[0].dispatchEvent(new window.Event("input"));
  assert.equal(editor.querySelectorAll("mark.find-hit").length, 2);
  panel.find("two");
  assert.equal(editor.querySelectorAll("mark.find-hit").length, 0);
  assert.equal(window.getSelection().toString(), "two");
  dom.window.close();
});

test("highlight and clear preserve mixed formatting, selection, and clean history", () => {
  const { dom, window, editor, panel, highlight } = setup('<p><b style="color:red;background:yellow">Hello</b><i style="color:blue"> world</i></p>');
  const original = editor.innerHTML;
  const history = new History(editor);
  history.attach();
  panel.find("lo wor");
  let inputCount = 0;
  editor.addEventListener("input", () => inputCount++);
  highlight.highlightSelection();
  assert.equal([...window.CSS.highlights.get("sdk-selection")][0].toString(), "lo wor");
  assert.ok(editor.classList.contains("sdk-highlight-selection"));
  assert.equal(editor.innerHTML, original);
  assert.equal(window.getSelection().toString(), "lo wor");
  assert.equal(history._cleanHtml(), original);
  highlight.clearHighlight();
  highlight.clearHighlight();
  assert.equal(window.CSS.highlights.size, 0);
  assert.equal(editor.classList.contains("sdk-highlight-selection"), false);
  assert.equal(editor.innerHTML, original);
  assert.equal(window.getSelection().toString(), "lo wor");
  assert.equal(inputCount, 0);
  assert.equal(history.canUndo(), false);
  history.detach();
  dom.window.close();
});

test("highlight can follow a manual/saved selection and repeated calls replace only its own highlight", () => {
  const { dom, window, editor, panel, highlight } = setup("<p>first second</p>");
  const range = document.createRange();
  range.setStart(editor.firstChild.firstChild, 0);
  range.setEnd(editor.firstChild.firstChild, 5);
  window.getSelection().addRange(range);
  saveSelection(editor);
  window.getSelection().removeAllRanges();
  highlight.highlightSelection();
  window.CSS.highlights.set("other-feature", new window.Highlight());
  panel.find("second");
  document.dispatchEvent(new window.Event("selectionchange"));
  assert.equal(editor.classList.contains("sdk-highlight-selection"), false);
  assert.equal([...window.CSS.highlights.get("sdk-selection")][0].toString(), "first");
  highlight.highlightSelection();
  assert.equal([...window.CSS.highlights.get("sdk-selection")][0].toString(), "second");
  highlight.clearHighlight();
  assert.equal(window.CSS.highlights.has("other-feature"), true);
  dom.window.close();
});

test("invalid selection and unsupported browsers fail explicitly without changing content", () => {
  const { dom, window, editor, panel, highlight } = setup("<p>text</p>");
  window.getSelection().selectAllChildren(editor);
  window.getSelection().collapseToStart();
  assert.throws(() => highlight.highlightSelection(), /no selection/);
  delete window.Highlight;
  assert.throws(() => highlight.highlightSelection(), /not support/);
  assert.equal(panel.find("text"), 1);
  highlight.clearHighlight();
  assert.equal(editor.innerHTML, "<p>text</p>");
  dom.window.close();
});

test("SDK sends the independent highlight commands and preserves the find payload", async () => {
  const { dom, window } = setup("<p>text</p>");
  window.eval(await readFile(new URL("../public/js/sdk.js", import.meta.url), "utf8"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const sdk = window.DocEditor.init({ container });
  const messages = [];
  sdk.iframe.contentWindow.postMessage = (message) => {
    messages.push(message);
    window.dispatchEvent(new window.MessageEvent("message", {
      source: sdk.iframe.contentWindow,
      data: { we: 1, re: message.id, result: message.cmd === "find" ? { matches: 1 } : { ok: true } },
    }));
  };
  assert.deepEqual(await sdk.find("text", { matchCase: true, regex: false }), { matches: 1 });
  assert.deepEqual(await sdk.highlightSelection(), { ok: true });
  assert.deepEqual(await sdk.clearHighlight(), { ok: true });
  assert.deepEqual(messages.map(m => m.cmd), ["find", "highlightSelection", "clearHighlight"]);
  assert.equal(JSON.stringify(messages[0].args), JSON.stringify({ query: "text", matchCase: true, regex: false }));
  sdk.destroy();
  dom.window.close();
});
