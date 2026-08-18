// Reuses the client-side, zero-dependency OOXML parser (public/js/docx.js) on
// the server by shimming the two browser DOM APIs it needs — DOMParser and
// document.createElement()/innerHTML — with jsdom. CompressionStream,
// DecompressionStream, atob, btoa, fetch and Blob are already native Node
// globals, so no shim is needed for those.
//
// Do not modify public/js/docx.js to special-case Node: this file's only job
// is to make the browser globals it expects exist, so client and server stay
// on exactly one parsing/export implementation.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.document = dom.window.document;
globalThis.Image = dom.window.Image;

export * from "../public/js/docx.js";
