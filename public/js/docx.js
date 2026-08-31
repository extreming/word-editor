// docx.js — dependency-free .docx read/write.
// Uses the browser's native CompressionStream/DecompressionStream ("deflate-raw")
// for ZIP inflate/deflate, plus manual ZIP container parsing and OOXML (Word ML)
// XML mapping. No external libraries.
//
// Import: paragraphs, runs (b/i/u/strike/sub/sup/color/highlight/size/font),
// headings, alignment, indentation, line spacing, native numbered/bulleted
// lists (numbering.xml + style-based numbering), tables (gridSpan/vMerge/shading),
// inline images, hyperlinks, page setup (sectPr), document title (core.xml),
// tracked changes (w:ins/w:del), comments (comments.xml + comment ranges).
// Export: the same set, generating a complete valid OOXML package.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const XMLNS = "http://www.w3.org/2000/xmlns/";

export function supportsDocx() {
  return typeof DecompressionStream !== "undefined" && typeof CompressionStream !== "undefined";
}

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------- raw deflate via native streams ----------------
async function streamCollect(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    len += value.length;
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
async function inflateRaw(data) {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  w.write(data);
  w.close();
  return streamCollect(ds.readable);
}
async function deflateRaw(data) {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  w.write(data);
  w.close();
  return streamCollect(cs.readable);
}

// ---------------- ZIP read ----------------
// Legacy binary .doc/.xls/.ppt files (OLE/CFB container format, pre-Office
// 2007) start with this exact 8-byte signature — distinguishing that from
// "just not a ZIP" up front means the file-open handler can tell a user
// "this is a legacy .doc, please convert it" instead of a generic parse
// error that looks like their file is simply corrupt.
const OLE_CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export function isLegacyOleFile(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== OLE_CFB_SIGNATURE[i]) return false;
  return true;
}
export async function unzip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const len = arrayBuffer.byteLength;
  if (isLegacyOleFile(bytes)) {
    throw new Error("This is a legacy binary Office file (.doc/.xls/.ppt), not a modern .docx — save it as .docx first, then reopen it.");
  }
  let eocd = -1;
  for (let i = len - 22; i >= 0 && i >= len - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP/DOCX file");
  const cdCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeader = view.getUint32(cdOffset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    const lNameLen = view.getUint16(localHeader + 26, true);
    const lExtraLen = view.getUint16(localHeader + 28, true);
    const dataStart = localHeader + 30 + lNameLen + lExtraLen;
    const compData = bytes.subarray(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = new Uint8Array(compData);
    else if (method === 8) content = await inflateRaw(compData);
    else throw new Error("Unsupported zip method " + method);
    files.set(name, content);
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------- ZIP write ----------------
function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
function u32(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }
function concat(arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export async function zip(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const comp = await deflateRaw(data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, comp,
    ]);
    localParts.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralBuf = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.size), u16(files.size),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return new Blob([concat([...localParts, centralBuf, eocd])], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// ---------------- helpers ----------------
function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function child(parent, ns, name) {
  for (const c of parent.children) if (c.namespaceURI === ns && c.localName === name) return c;
  return null;
}
function children(parent, ns, name) {
  const out = [];
  for (const c of parent.children) if (c.namespaceURI === ns && c.localName === name) out.push(c);
  return out;
}
function attr(el, name) {
  // OOXML attributes are namespaced (w:val etc.); DOMParser exposes both forms.
  return el.getAttribute("w:val") !== null && name === "val"
    ? el.getAttribute("w:val")
    : (el.getAttributeNS(W, name) ?? el.getAttribute("w:" + name) ?? el.getAttribute(name));
}
function boolProp(el) {
  if (!el) return false;
  const v = attr(el, "val");
  return !(v === "0" || v === "false" || v === "none");
}
function findDesc(el, localName) {
  const found = el.getElementsByTagName("*");
  for (const n of found) if (n.localName === localName) return n;
  return null;
}

const TW_PER_PX = 15;       // 1px = 0.75pt = 15 twips
const EMU_PER_PX = 9525;

// Word named highlight colors <-> css hex
const HIGHLIGHT_COLORS = {
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff",
  blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080",
  darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000",
  darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff",
};
const HEX_TO_HIGHLIGHT = Object.fromEntries(
  Object.entries(HIGHLIGHT_COLORS).map(([k, v]) => [v.slice(1), k])
);

export const PAGE_SIZES = {
  Letter: { w: 12240, h: 15840 },
  A4: { w: 11906, h: 16838 },
  Legal: { w: 12240, h: 20160 },
  A3: { w: 16838, h: 23811 },
};
export const DEFAULT_PAGE_SETUP = {
  size: "Letter", orientation: "portrait",
  margins: { top: 1, right: 1, bottom: 1, left: 1 }, // inches
};

const IMG_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff",
};

function bytesToDataUrl(bytes, mime) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}
function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function base64ToUtf8(value) {
  try {
    const bin = atob(value || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}
function dataUrlToBytes(url) {
  const i = url.indexOf(",");
  const meta = url.slice(5, i);
  const b64 = meta.includes("base64");
  const body = url.slice(i + 1);
  const mime = meta.split(";")[0] || "application/octet-stream";
  if (b64) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime };
}

// W3CDTF timestamp from ms-epoch, ISO string, or nothing
function tsIso(v) {
  let d;
  if (v == null || v === "") d = new Date();
  else if (/^\d+$/.test(String(v))) d = new Date(parseInt(v, 10));
  else d = new Date(v);
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

// ============================================================
// IMPORT: .docx -> { html, pageSetup, title, comments }
// ============================================================

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) throw new Error("XML parse error");
  return doc;
}
function decodePart(files, name) {
  const data = files.get(name);
  return data ? new TextDecoder().decode(data) : null;
}

function parseRels(files, relPath) {
  const rels = new Map();
  const text = decodePart(files, relPath);
  if (!text) return rels;
  const doc = parseXml(text);
  for (const rel of doc.getElementsByTagName("Relationship")) {
    rels.set(rel.getAttribute("Id"), {
      type: rel.getAttribute("Type") || "",
      target: rel.getAttribute("Target") || "",
      mode: rel.getAttribute("TargetMode") || "Internal",
    });
  }
  return rels;
}

function parseNumbering(files) {
  // numId -> { ilvl -> { fmt, start } }
  const text = decodePart(files, "word/numbering.xml");
  const fmtByNum = new Map();
  if (!text) return fmtByNum;
  const doc = parseXml(text);
  const abstracts = new Map();
  for (const ab of doc.getElementsByTagNameNS(W, "abstractNum")) {
    const id = ab.getAttributeNS(W, "abstractNumId") ?? ab.getAttribute("w:abstractNumId");
    const levels = {};
    for (const lvl of children(ab, W, "lvl")) {
      const ilvl = lvl.getAttributeNS(W, "ilvl") ?? lvl.getAttribute("w:ilvl");
      const numFmt = child(lvl, W, "numFmt");
      const start = child(lvl, W, "start");
      levels[ilvl] = {
        fmt: numFmt ? attr(numFmt, "val") : "decimal",
        start: start ? parseInt(attr(start, "val"), 10) || 1 : 1,
      };
    }
    abstracts.set(id, levels);
  }
  for (const num of doc.getElementsByTagNameNS(W, "num")) {
    const numId = num.getAttributeNS(W, "numId") ?? num.getAttribute("w:numId");
    const absRef = child(num, W, "abstractNumId");
    const absId = absRef ? attr(absRef, "val") : null;
    const levels = Object.fromEntries(Object.entries(abstracts.get(absId) || {})
      .map(([level, value]) => [level, { ...value }]));
    for (const override of children(num, W, "lvlOverride")) {
      const ilvl = override.getAttributeNS(W, "ilvl") ?? override.getAttribute("w:ilvl");
      const startOverride = child(override, W, "startOverride");
      if (startOverride) {
        levels[ilvl] = levels[ilvl] || { fmt: "decimal", start: 1 };
        levels[ilvl].start = parseInt(attr(startOverride, "val"), 10) || 1;
      }
    }
    fmtByNum.set(numId, levels);
  }
  return fmtByNum;
}

// styles.xml: styleId -> {numId, ilvl} for styles that carry their own numbering
function parseStylesNumbering(files) {
  const map = new Map();
  const text = decodePart(files, "word/styles.xml");
  if (!text) return map;
  let doc;
  try { doc = parseXml(text); } catch { return map; }
  for (const style of doc.getElementsByTagNameNS(W, "style")) {
    const id = (style.getAttributeNS(W, "styleId") ?? style.getAttribute("w:styleId") ?? "").toLowerCase();
    if (!id) continue;
    const pPr = child(style, W, "pPr");
    const numPr = pPr && child(pPr, W, "numPr");
    if (!numPr) continue;
    const numIdEl = child(numPr, W, "numId");
    const ilvlEl = child(numPr, W, "ilvl");
    if (!numIdEl) continue;
    const numId = attr(numIdEl, "val");
    if (!numId || numId === "0") continue;
    map.set(id, { numId, ilvl: ilvlEl ? parseInt(attr(ilvlEl, "val"), 10) || 0 : 0 });
  }
  return map;
}

// word/comments.xml: numeric id -> {author, date, text}
function parseComments(files) {
  const map = new Map();
  const text = decodePart(files, "word/comments.xml");
  if (!text) return map;
  let doc;
  try { doc = parseXml(text); } catch { return map; }
  for (const c of doc.getElementsByTagNameNS(W, "comment")) {
    const id = c.getAttributeNS(W, "id") ?? c.getAttribute("w:id");
    if (id == null) continue;
    const author = c.getAttributeNS(W, "author") ?? c.getAttribute("w:author") ?? "";
    const date = c.getAttributeNS(W, "date") ?? c.getAttribute("w:date") ?? "";
    const paras = children(c, W, "p").map((p) => p.textContent);
    map.set(id, { author, date, text: paras.join("\n").trim() });
  }
  return map;
}

function resolveTarget(target) {
  // rel targets are relative to word/
  if (target.startsWith("/")) return target.slice(1);
  const parts = ("word/" + target).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

function relationshipImagePart(node, ctx) {
  const blip = findDesc(node, "blip");
  const imageData = findDesc(node, "imagedata");
  const relId = (blip && (blip.getAttributeNS(R, "embed") || blip.getAttribute("r:embed")))
    || (imageData && (imageData.getAttributeNS(R, "id") || imageData.getAttribute("r:id")));
  const rel = relId && ctx.rels.get(relId);
  if (!rel) return "";
  const partName = resolveTarget(rel.target);
  const data = ctx.files.get(partName);
  if (!data) return "";
  const ext = (partName.split(".").pop() || "").toLowerCase();
  return { data, ext, mime: IMG_MIME[ext], partName };
}

function imageFromDrawing(node, ctx) {
  const image = relationshipImagePart(node, ctx);
  if (!image) return "";
  const { data, mime } = image;
  if (!mime) return ""; // emf/wmf etc. — browser can't render
  let style = "";
  const extent = findDesc(node, "extent");
  if (extent) {
    const cx = parseInt(extent.getAttribute("cx"), 10);
    const cy = parseInt(extent.getAttribute("cy"), 10);
    if (cx > 0 && cy > 0) {
      style = ` width="${Math.round(cx / EMU_PER_PX)}" height="${Math.round(cy / EMU_PER_PX)}"`;
    }
  }
  return `<img src="${bytesToDataUrl(data, mime)}"${style} alt="">`;
}

function namespaceUriUsedBy(node, prefix) {
  const scoped = node.lookupNamespaceURI(prefix);
  if (scoped) return scoped;
  const elements = [node, ...node.getElementsByTagName("*")];
  for (const element of elements) {
    if (element.prefix === prefix && element.namespaceURI) return element.namespaceURI;
    for (const attribute of element.attributes) {
      if (attribute.prefix === prefix && attribute.namespaceURI) return attribute.namespaceURI;
    }
  }
  return null;
}

function serializeXmlNode(node) {
  const clone = node.cloneNode(true);
  const sourceChoices = [];
  const clonedChoices = [];
  if (node.nodeType === 1 && node.namespaceURI === MC && node.localName === "Choice") {
    sourceChoices.push(node);
    clonedChoices.push(clone);
  }
  sourceChoices.push(...node.getElementsByTagNameNS(MC, "Choice"));
  clonedChoices.push(...clone.getElementsByTagNameNS(MC, "Choice"));

  // `mc:Choice/@Requires` contains namespace prefixes as plain text.  XMLSerializer
  // preserves declarations needed by element/attribute names, but it may drop a
  // declaration inherited from document.xml's root when the copied fragment only
  // mentions that prefix in Requires.  Word treats such a Choice as unreadable
  // OOXML even though ordinary XML parsers accept it.  Materialize every required
  // namespace on the Choice before storing the fragment in data-ooxml.
  for (let i = 0; i < sourceChoices.length; i++) {
    const source = sourceChoices[i];
    const copy = clonedChoices[i];
    for (const prefix of (source.getAttribute("Requires") || "").trim().split(/\s+/).filter(Boolean)) {
      // Older editor state may already lack the declaration at Choice scope.
      // Recover it from a prefixed descendant before re-exporting that state.
      const uri = namespaceUriUsedBy(source, prefix);
      if (uri && copy.lookupNamespaceURI(prefix) !== uri) {
        copy.setAttributeNS(XMLNS, `xmlns:${prefix}`, uri);
      }
    }
  }
  return new XMLSerializer().serializeToString(clone);
}

function relationshipImage(node, ctx) {
  const image = relationshipImagePart(node, ctx);
  if (!image) return null;
  const { data, mime } = image;
  if (!mime || mime === "image/tiff") return null;
  let size = "";
  const extent = findDesc(node, "extent");
  if (extent) {
    const cx = parseInt(extent.getAttribute("cx"), 10);
    const cy = parseInt(extent.getAttribute("cy"), 10);
    if (cx > 0 && cy > 0) size = ` width="${Math.round(cx / EMU_PER_PX)}" height="${Math.round(cy / EMU_PER_PX)}"`;
  }
  return `<img src="${bytesToDataUrl(data, mime)}"${size} alt="">`;
}

function complexObjectKind(node) {
  const local = node.localName;
  if (node.namespaceURI === MATH || local === "oMath" || local === "oMathPara" || findDesc(node, "oMath")) return "formula";
  if (local === "object" || findDesc(node, "OLEObject")) return "embedded";
  if (findDesc(node, "relIds")) return "smartart";
  if (findDesc(node, "chart")) return "chart";
  // Modern WordArt is stored as a DrawingML text box rather than the legacy
  // VML textpath. Text fill/outline/warp properties identify that native form.
  if (findDesc(node, "textpath") || findDesc(node, "textFill")
      || findDesc(node, "textOutline") || findDesc(node, "prstTxWarp")) return "wordart";
  if (local === "pict" || findDesc(node, "shape")) return "shape";
  if (local === "drawing" || local === "AlternateContent") return "drawing";
  return null;
}

function isPlainPictureDrawing(node) {
  return node.localName === "drawing" && !!findDesc(node, "pic") && !!findDesc(node, "blip")
    && !findDesc(node, "relIds") && !findDesc(node, "chart");
}

function simpleLineDrawingPreview(node) {
  const geometry = findDesc(node, "prstGeom");
  if (!findDesc(node, "wsp") || findDesc(node, "chart") || findDesc(node, "relIds")
      || findDesc(node, "blip") || !geometry || geometry.getAttribute("prst") !== "line"
      || findDesc(node, "txbxContent")) return null;

  const transform = findDesc(node, "xfrm");
  const rotation = transform && parseInt(transform.getAttribute("rot") || "0", 10);
  if (rotation) return null;

  const extent = findDesc(node, "extent");
  const cx = extent && parseInt(extent.getAttribute("cx"), 10);
  const cy = extent && parseInt(extent.getAttribute("cy"), 10);
  if (!(cx > 0) || Math.abs(cy || 0) > Math.max(EMU_PER_PX * 3, cx * 0.02)) return null;

  const line = findDesc(node, "ln");
  if (!line) return null;
  const dash = findDesc(line, "prstDash");
  if (dash && !["solid", "sysDot", "sysDash"].includes(dash.getAttribute("val"))) return null;
  for (const endName of ["headEnd", "tailEnd"]) {
    const end = findDesc(line, endName);
    if (end && !["", "none"].includes(end.getAttribute("type") || "")) return null;
  }

  const colorNode = findDesc(line, "srgbClr");
  const colorValue = colorNode && colorNode.getAttribute("val");
  const color = /^[0-9a-f]{6}$/i.test(colorValue || "") ? `#${colorValue}` : "#000000";
  const strokeEmu = parseInt(line.getAttribute("w") || String(EMU_PER_PX), 10);
  const stroke = Math.max(1, Math.min(12, Math.round((strokeEmu / EMU_PER_PX) * 100) / 100));
  const width = Math.max(1, Math.min(2000, Math.round(cx / EMU_PER_PX)));
  const dashStyle = dash && dash.getAttribute("val") !== "solid" ? "dashed" : "solid";

  const offsetPx = (positionName) => {
    const position = findDesc(node, positionName);
    const offset = position && findDesc(position, "posOffset");
    const emu = offset && parseInt(offset.textContent || "0", 10);
    return Number.isFinite(emu) ? Math.max(-2000, Math.min(2000, Math.round((emu / EMU_PER_PX) * 100) / 100)) : 0;
  };
  const x = offsetPx("positionH");
  const y = offsetPx("positionV");
  return `<span class="ooxml-line-preview" aria-hidden="true" ` +
    `style="width:${width}px;max-width:100%;border-top:${stroke}px ${dashStyle} ${color};` +
    `transform:translate(${x}px,${y}px)"></span>`;
}

function vmlLengthPx(value) {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)(pt|px|in)?$/i);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit = (match[2] || "px").toLowerCase();
  const px = unit === "pt" ? amount * 96 / 72 : unit === "in" ? amount * 96 : amount;
  return Number.isFinite(px)
    ? Math.max(-2000, Math.min(2000, Math.round(px * 100) / 100)) : null;
}

function vmlStyleMap(shape) {
  const style = new Map();
  for (const declaration of (shape && shape.getAttribute("style") || "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon <= 0) continue;
    style.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim());
  }
  return style;
}

function vmlAnchorGeometry(node) {
  const shape = findDesc(node, "shape");
  const style = vmlStyleMap(shape);
  if (!shape || style.get("position") !== "absolute") return null;
  const left = vmlLengthPx(style.get("margin-left"));
  const top = vmlLengthPx(style.get("margin-top"));
  const width = vmlLengthPx(style.get("width"));
  const height = vmlLengthPx(style.get("height"));
  return left != null && top != null && width > 0 && height > 0
    ? { shape, left, top, width, height } : null;
}

function simpleVmlTextBoxPreview(node, ctx) {
  const anchor = vmlAnchorGeometry(node);
  const shape = anchor && anchor.shape;
  const textBox = shape && findDesc(shape, "textbox");
  const content = textBox && findDesc(textBox, "txbxContent");
  if (!shape || !content || findDesc(content, "drawing") || findDesc(content, "pict")
      || findDesc(content, "object") || findDesc(content, "tbl") || findDesc(content, "AlternateContent")) {
    return null;
  }

  const paragraphs = children(content, W, "p");
  const text = [...content.getElementsByTagNameNS(W, "t")]
    .map((textNode) => textNode.textContent || "").join("").trim();
  if (!paragraphs.length || !text) return null;

  const paragraphHtml = paragraphs.map((paragraph) => {
    const info = paragraphStyleInfo(paragraph, ctx);
    const inline = inlineToHtml(paragraph, ctx);
    const styles = [...info.styles, "display:block", "margin:0"];
    return `<span class="ooxml-textbox-paragraph" style="${styles.join(";")}">` +
      `${inline.html || "<br>"}</span>`;
  }).join("");
  const stroked = shape.getAttribute("stroked") !== "f";
  const strokeColor = shape.getAttribute("strokecolor");
  const borderColor = /^#[0-9a-f]{6}$/i.test(strokeColor || "") ? strokeColor : "#000000";
  const filled = shape.getAttribute("filled") !== "f";
  const fillColor = shape.getAttribute("fillcolor");
  const background = filled && /^#[0-9a-f]{6}$/i.test(fillColor || "") ? fillColor : (filled ? "#ffffff" : "transparent");
  return `<span class="ooxml-textbox-preview" style="border:${stroked ? `1px solid ${borderColor}` : "0"};` +
    `background:${background}">${paragraphHtml}</span>`;
}

const COMPLEX_LABELS = {
  formula: "Formula · read-only", embedded: "Embedded object · read-only",
  smartart: "SmartArt · read-only", chart: "Chart · read-only",
  wordart: "WordArt · read-only", shape: "Shape · read-only", drawing: "Drawing · read-only",
  image: "Image · read-only", line: "Horizontal line · read-only",
  textbox: "Text box · read-only",
};

function mathChild(node, name) {
  return [...node.children].find((childNode) => childNode.localName === name) || null;
}
function mathValue(node, fallback = "") {
  return node && (node.getAttribute("m:val") || node.getAttribute("val")) || fallback;
}
function ommlToHtml(node) {
  if (!node) return "";
  const local = node.localName;
  if (local === "t") return escHtml(node.textContent || "");
  if (local === "f") {
    return `<span class="omml-frac"><span class="omml-num">${ommlToHtml(mathChild(node, "num"))}</span>` +
      `<span class="omml-den">${ommlToHtml(mathChild(node, "den"))}</span></span>`;
  }
  if (local === "rad") {
    const degree = ommlToHtml(mathChild(node, "deg"));
    return `<span class="omml-rad">${degree ? `<sup>${degree}</sup>` : ""}√<span class="omml-radicand">${ommlToHtml(mathChild(node, "e"))}</span></span>`;
  }
  if (local === "sSup") return `${ommlToHtml(mathChild(node, "e"))}<sup>${ommlToHtml(mathChild(node, "sup"))}</sup>`;
  if (local === "sSub") return `${ommlToHtml(mathChild(node, "e"))}<sub>${ommlToHtml(mathChild(node, "sub"))}</sub>`;
  if (local === "sSubSup") return `${ommlToHtml(mathChild(node, "e"))}<sub>${ommlToHtml(mathChild(node, "sub"))}</sub><sup>${ommlToHtml(mathChild(node, "sup"))}</sup>`;
  if (local === "d") {
    const dPr = mathChild(node, "dPr");
    const begin = mathValue(dPr && mathChild(dPr, "begChr"), "(");
    const end = mathValue(dPr && mathChild(dPr, "endChr"), ")");
    return `${escHtml(begin)}${ommlToHtml(mathChild(node, "e"))}${escHtml(end)}`;
  }
  if (local === "nary") {
    const naryPr = mathChild(node, "naryPr");
    const symbol = mathValue(naryPr && mathChild(naryPr, "chr"), "∫");
    return `<span class="omml-nary">${escHtml(symbol)}<span class="omml-limits"><sup>${ommlToHtml(mathChild(node, "sup"))}</sup><sub>${ommlToHtml(mathChild(node, "sub"))}</sub></span>${ommlToHtml(mathChild(node, "e"))}</span>`;
  }
  if (local === "m") {
    const rows = [...node.children].filter((childNode) => childNode.localName === "mr");
    return `<span class="omml-matrix">${rows.map((row) => `<span class="omml-row">${[...row.children].filter((cell) => cell.localName === "e").map((cell) => `<span class="omml-cell">${ommlToHtml(cell)}</span>`).join("")}</span>`).join("")}</span>`;
  }
  return [...node.children].map(ommlToHtml).join("");
}

function complexObjectHtml(node, ctx, rawXml, options = {}) {
  const linePreview = simpleLineDrawingPreview(node);
  const textBoxPreview = simpleVmlTextBoxPreview(node, ctx);
  const vmlAnchor = vmlAnchorGeometry(node);
  const kind = options.kind || (linePreview ? "line" : null) || (textBoxPreview ? "textbox" : null)
    || complexObjectKind(node) || "drawing";
  const formulaPreview = kind === "formula" ? ommlToHtml(node) : "";
  const preview = relationshipImage(node, ctx)
    || linePreview
    || textBoxPreview
    || (formulaPreview ? `<span class="ooxml-formula-preview">${formulaPreview}</span>` : "");
  let detail = options.detail || "";
  if (kind === "formula") detail = String(node.textContent || "").replace(/\s+/g, " ").trim();
  if (kind === "wordart") {
    const textpath = findDesc(node, "textpath");
    const textBox = findDesc(node, "txbxContent");
    const textBoxText = textBox
      ? [...textBox.getElementsByTagNameNS(W, "t")].map((textNode) => textNode.textContent || "").join("") : "";
    detail = textpath && (textpath.getAttribute("string") || textpath.getAttribute("v:string"))
      || textBoxText.replace(/\s+/g, " ").trim() || detail;
  }
  if (kind === "embedded") {
    const ole = findDesc(node, "OLEObject");
    detail = ole && (ole.getAttribute("ProgID") || ole.getAttribute("Type")) || detail;
  }
  detail = detail ? `: ${detail.slice(0, 120)}` : "";
  const label = `${COMPLEX_LABELS[kind] || COMPLEX_LABELS.drawing}${detail}`;
  const classes = `ooxml-object ooxml-${kind}${linePreview ? " ooxml-simple-line" : ""}` +
    `${textBoxPreview ? " ooxml-simple-textbox" : ""}${vmlAnchor ? " ooxml-vml-anchored" : ""}` +
    `${options.anchored ? " ooxml-anchored" : ""}${preview ? " has-preview" : ""}`;
  const anchorStyle = vmlAnchor
    ? ` style="left:${vmlAnchor.left}px;top:${vmlAnchor.top}px;width:${vmlAnchor.width}px;height:${vmlAnchor.height}px"` : "";
  return `<span class="${classes}"${anchorStyle} data-ooxml-kind="${kind}" data-ooxml="${utf8ToBase64(rawXml)}" contenteditable="false" title="${escXml(label)}">` +
    `${preview || ""}<span class="ooxml-object-label">${escHtml(label)}</span></span>`;
}

function preservedRunObjectHtml(run, childNode, ctx, options) {
  const rPr = child(run, W, "rPr");
  const raw = `<w:r xmlns:w="${W}">${rPr ? serializeXmlNode(rPr) : ""}${serializeXmlNode(childNode)}</w:r>`;
  return complexObjectHtml(childNode, ctx, raw, options);
}

function isAnchoredWordArt(node) {
  return complexObjectKind(node) === "wordart" && !!findDesc(node, "anchor");
}

function runToHtml(r, ctx) {
  const rPr = child(r, W, "rPr");
  let out = "";
  let pageBreak = false;
  let deferred = "";
  const segs = [];
  for (const c of r.children) {
    if (c.localName === "AlternateContent") {
      const anchored = isAnchoredWordArt(c);
      const objectHtml = preservedRunObjectHtml(r, c, ctx, anchored ? { anchored: true } : undefined);
      if (anchored) deferred += objectHtml;
      else segs.push({ raw: objectHtml });
      continue;
    }
    if (c.namespaceURI !== W && c.localName !== "drawing") continue;
    if (c.localName === "t") segs.push({ t: c.textContent });
    else if (c.localName === "delText") segs.push({ t: c.textContent });
    else if (c.localName === "tab") segs.push({ t: "\t" });
    else if (c.localName === "br") {
      const type = attr(c, "type");
      if (type === "page") pageBreak = true;
      else segs.push({ br: true });
    }
    else if (c.localName === "drawing") {
      if (!isPlainPictureDrawing(c)) {
        const anchored = isAnchoredWordArt(c);
        const objectHtml = preservedRunObjectHtml(r, c, ctx, anchored ? { anchored: true } : undefined);
        if (anchored) deferred += objectHtml;
        else segs.push({ raw: objectHtml });
      } else {
        const rendered = imageFromDrawing(c, ctx);
        if (rendered) segs.push({ raw: rendered });
        else {
          const image = relationshipImagePart(c, ctx);
          const format = image && image.ext ? image.ext.toUpperCase() : "unsupported";
          segs.push({ raw: preservedRunObjectHtml(r, c, ctx, {
            kind: "image",
            detail: `${format} preview unavailable in browser`,
          }) });
        }
      }
    }
    else if (c.localName === "object" || c.localName === "pict") {
      segs.push({ raw: preservedRunObjectHtml(r, c, ctx) });
    }
    else if (c.localName === "noBreakHyphen") segs.push({ t: "‑" });
  }
  let open = "", close = "";
  if (rPr) {
    if (boolProp(child(rPr, W, "b"))) { open += "<b>"; close = "</b>" + close; }
    if (boolProp(child(rPr, W, "i"))) { open += "<i>"; close = "</i>" + close; }
    const u = child(rPr, W, "u");
    if (u && attr(u, "val") !== "none") { open += "<u>"; close = "</u>" + close; }
    if (boolProp(child(rPr, W, "strike"))) { open += "<s>"; close = "</s>" + close; }
    const va = child(rPr, W, "vertAlign");
    if (va) {
      const v = attr(va, "val");
      if (v === "superscript") { open += "<sup>"; close = "</sup>" + close; }
      else if (v === "subscript") { open += "<sub>"; close = "</sub>" + close; }
    }
    const styles = [];
    const color = child(rPr, W, "color");
    if (color) {
      const v = attr(color, "val");
      if (v && v !== "auto") styles.push("color:#" + v.toLowerCase());
    }
    const hl = child(rPr, W, "highlight");
    if (hl) {
      const v = attr(hl, "val");
      if (v && v !== "none") styles.push("background-color:" + (HIGHLIGHT_COLORS[v] || v));
    } else {
      const shd = child(rPr, W, "shd");
      if (shd) {
        const fill = shd.getAttributeNS(W, "fill") ?? shd.getAttribute("w:fill");
        if (fill && fill !== "auto") styles.push("background-color:#" + fill.toLowerCase());
      }
    }
    const sz = child(rPr, W, "sz");
    if (sz) {
      const v = parseInt(attr(sz, "val"), 10);
      if (v) styles.push("font-size:" + v / 2 + "pt");
    }
    const rFonts = child(rPr, W, "rFonts");
    if (rFonts) {
      const f = rFonts.getAttributeNS(W, "ascii") ?? rFonts.getAttribute("w:ascii");
      if (f) styles.push("font-family:" + f);
    }
    if (styles.length) { open += `<span style="${styles.join(";")}">`; close = "</span>" + close; }
  }
  for (const seg of segs) {
    if (seg.raw !== undefined) { out += seg.raw; continue; }
    if (seg.br) { out += "<br>"; continue; }
    out += open + escHtml(seg.t).replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;") + close;
  }
  return { html: out, pageBreak, deferred };
}

// Processes inline-level children of a paragraph (runs, hyperlinks, tracked
// changes, comment range markers) into HTML.
function inlineToHtml(parent, ctx) {
  let html = "";
  let deferred = "";
  let pageBreak = false;
  for (const node of parent.children) {
    if (node.namespaceURI === MATH || node.localName === "oMath" || node.localName === "oMathPara") {
      html += complexObjectHtml(node, ctx, serializeXmlNode(node));
      continue;
    }
    if (node.localName === "AlternateContent") {
      const anchored = isAnchoredWordArt(node);
      const objectHtml = complexObjectHtml(node, ctx, serializeXmlNode(node), anchored ? { anchored: true } : undefined);
      if (anchored) deferred += objectHtml;
      else html += objectHtml;
      continue;
    }
    if (node.namespaceURI !== W) continue;
    if (node.localName === "r") {
      const r = runToHtml(node, ctx);
      html += r.html;
      deferred += r.deferred;
      pageBreak = pageBreak || r.pageBreak;
    } else if (node.localName === "hyperlink") {
      const id = node.getAttributeNS(R, "id") || node.getAttribute("r:id");
      const rel = id && ctx.rels.get(id);
      const href = rel && rel.mode === "External" ? rel.target : null;
      const inner = inlineToHtml(node, ctx);
      pageBreak = pageBreak || inner.pageBreak;
      html += href ? `<a href="${escHtml(href)}">${inner.html}</a>` : inner.html;
    } else if (node.localName === "ins" || node.localName === "del") {
      // tracked changes -> <ins>/<del> wrappers the editor's review UI understands
      const author = node.getAttributeNS(W, "author") ?? node.getAttribute("w:author") ?? "";
      const date = node.getAttributeNS(W, "date") ?? node.getAttribute("w:date") ?? "";
      const inner = inlineToHtml(node, ctx);
      pageBreak = pageBreak || inner.pageBreak;
      const tag = node.localName;
      html += `<${tag} class="tc-${tag}" data-author="${escHtml(author)}" data-ts="${escHtml(date)}">${inner.html}</${tag}>`;
    } else if (node.localName === "commentRangeStart") {
      const id = node.getAttributeNS(W, "id") ?? node.getAttribute("w:id");
      if (id != null && ctx.comments && ctx.comments.has(id)) {
        // if the range crosses paragraphs the HTML parser auto-closes the span
        // at the paragraph end; the anchor then covers the first portion
        html += `<span class="comment-ref" data-cid="c${id}">`;
      }
    } else if (node.localName === "commentRangeEnd") {
      const id = node.getAttributeNS(W, "id") ?? node.getAttribute("w:id");
      if (id != null && ctx.comments && ctx.comments.has(id)) html += `</span>`;
    } else if (node.localName === "smartTag" || node.localName === "sdt" || node.localName === "sdtContent") {
      // unwrap containers we don't model (content controls)
      const target = node.localName === "sdt" ? (child(node, W, "sdtContent") || node) : node;
      const inner = inlineToHtml(target, ctx);
      html += inner.html;
      pageBreak = pageBreak || inner.pageBreak;
    }
  }
  return { html: html + deferred, pageBreak };
}

function paragraphStyleInfo(p, ctx) {
  const pPr = child(p, W, "pPr");
  const info = { tag: "p", styles: [], numId: null, ilvl: 0, pageBreakBefore: false, listTag: null };
  if (!pPr) return info;
  const pStyle = child(pPr, W, "pStyle");
  if (pStyle) {
    const v = (attr(pStyle, "val") || "").toLowerCase();
    const m = v.match(/heading(\d)/);
    if (m && +m[1] >= 1 && +m[1] <= 6) info.tag = "h" + m[1];
    else if (v === "title") info.tag = "h1";
    else if (v === "quote" || v === "intensequote") info.tag = "blockquote";
    else {
      // style-based numbering: explicit style->numPr map, else Word's built-in
      // ListBullet / ListNumber style-name conventions
      const styleNum = ctx && ctx.styleNumbering && ctx.styleNumbering.get(v);
      if (styleNum) {
        info.numId = styleNum.numId;
        info.ilvl = styleNum.ilvl;
      } else {
        const lm = v.match(/^list(bullet|number)(\d)?$/);
        if (lm) {
          info.listTag = lm[1] === "bullet" ? "ul" : "ol";
          info.ilvl = lm[2] ? parseInt(lm[2], 10) - 1 : 0;
        }
      }
    }
  }
  const jc = child(pPr, W, "jc");
  if (jc) {
    const v = attr(jc, "val");
    if (v === "both" || v === "distribute") info.styles.push("text-align:justify");
    else if (v === "center" || v === "right" || v === "left") info.styles.push("text-align:" + v);
    else if (v === "start") info.styles.push("text-align:left");
    else if (v === "end") info.styles.push("text-align:right");
  }
  const ind = child(pPr, W, "ind");
  if (ind) {
    const left = parseInt(ind.getAttributeNS(W, "left") ?? ind.getAttribute("w:left"), 10);
    const first = parseInt(ind.getAttributeNS(W, "firstLine") ?? ind.getAttribute("w:firstLine"), 10);
    const hang = parseInt(ind.getAttributeNS(W, "hanging") ?? ind.getAttribute("w:hanging"), 10);
    if (left) info.styles.push("margin-left:" + Math.round(left / TW_PER_PX) + "px");
    if (first) info.styles.push("text-indent:" + Math.round(first / TW_PER_PX) + "px");
    else if (hang) info.styles.push("text-indent:-" + Math.round(hang / TW_PER_PX) + "px");
  }
  const spacing = child(pPr, W, "spacing");
  if (spacing) {
    const line = parseInt(spacing.getAttributeNS(W, "line") ?? spacing.getAttribute("w:line"), 10);
    const rule = spacing.getAttributeNS(W, "lineRule") ?? spacing.getAttribute("w:lineRule");
    if (line && (!rule || rule === "auto")) {
      const lh = Math.round((line / 240) * 100) / 100;
      if (lh !== 1) info.styles.push("line-height:" + lh);
    }
  }
  if (boolProp(child(pPr, W, "pageBreakBefore"))) info.pageBreakBefore = true;
  const numPr = child(pPr, W, "numPr");
  if (numPr) {
    const numIdEl = child(numPr, W, "numId");
    const ilvlEl = child(numPr, W, "ilvl");
    info.numId = numIdEl ? attr(numIdEl, "val") : info.numId;
    info.ilvl = ilvlEl ? parseInt(attr(ilvlEl, "val"), 10) || 0 : info.ilvl;
    if (info.numId === "0") info.numId = null; // numId 0 = "no numbering"
  }
  return info;
}

function tableToHtml(tbl, ctx) {
  // Build a model first so vMerge continuation cells can extend rowspans.
  const rows = [];
  let merges = new Map(); // gridCol -> model cell spanning from the previous row
  for (const tr of children(tbl, W, "tr")) {
    const row = [];
    const nextMerges = new Map();
    let gridCol = 0;
    for (const tc of children(tr, W, "tc")) {
      const tcPr = child(tc, W, "tcPr");
      let colspan = 1, vMerge = null, shd = null, widthCss = null;
      if (tcPr) {
        const gs = child(tcPr, W, "gridSpan");
        if (gs) colspan = parseInt(attr(gs, "val"), 10) || 1;
        const vm = child(tcPr, W, "vMerge");
        if (vm) vMerge = attr(vm, "val") || "continue";
        const sh = child(tcPr, W, "shd");
        if (sh) {
          const fill = sh.getAttributeNS(W, "fill") ?? sh.getAttribute("w:fill");
          if (fill && fill !== "auto") shd = "#" + fill.toLowerCase();
        }
        const tcW = child(tcPr, W, "tcW");
        if (tcW) {
          const type = tcW.getAttributeNS(W, "type") ?? tcW.getAttribute("w:type");
          const wv = parseInt(tcW.getAttributeNS(W, "w") ?? tcW.getAttribute("w:w"), 10);
          if (wv > 0 && type === "dxa") widthCss = Math.round(wv / TW_PER_PX) + "px";
          else if (wv > 0 && type === "pct") widthCss = Math.round(wv / 50) + "%";
        }
      }
      if (vMerge === "continue") {
        const origin = merges.get(gridCol);
        if (origin) {
          origin.rowspan++;
          nextMerges.set(gridCol, origin);
          gridCol += origin.colspan;
          continue;
        }
        vMerge = null; // continuation without a restart above: treat as normal
      }
      let inner = "";
      for (const block of tc.children) {
        if (block.namespaceURI !== W) continue;
        if (block.localName === "p") inner += renderParagraph(block, ctx);
        else if (block.localName === "tbl") inner += tableToHtml(block, ctx);
      }
      const cell = { colspan, rowspan: 1, shd, widthCss, inner: inner || "<p><br></p>" };
      row.push(cell);
      if (vMerge === "restart") nextMerges.set(gridCol, cell);
      gridCol += colspan;
    }
    rows.push(row);
    // OOXML writes a continuation tc for every vertically merged cell in each
    // covered row. Only those continuations (and new restarts) remain active;
    // otherwise a completed merge can leak into a later, unrelated row.
    merges = nextMerges;
  }
  let html = '<table><tbody>';
  for (const row of rows) {
    html += "<tr>";
    for (const c of row) {
      const attrs = [];
      if (c.colspan > 1) attrs.push(`colspan="${c.colspan}"`);
      if (c.rowspan > 1) attrs.push(`rowspan="${c.rowspan}"`);
      const st = [];
      if (c.shd) st.push("background-color:" + c.shd);
      // Word's `w:color w:val="auto"` adapts to the current background.
      // Browsers do not: an omitted CSS color inherits the editor's dark ink,
      // which makes automatic text almost invisible in dark shaded cells.
      // Set a readable inherited foreground for dark fills; an explicit run
      // color remains on its child span and therefore still wins.
      if (c.shd && /^#[0-9a-f]{6}$/i.test(c.shd)) {
        const rgb = [1, 3, 5].map((i) => parseInt(c.shd.slice(i, i + 2), 16) / 255);
        const linear = rgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        if (luminance < 0.18) st.push("color:#ffffff");
      }
      if (c.widthCss) st.push("width:" + c.widthCss);
      if (st.length) attrs.push(`style="${st.join(";")}"`);
      html += `<td ${attrs.join(" ")}>${c.inner}</td>`;
    }
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

function renderParagraph(p, ctx) {
  const info = paragraphStyleInfo(p, ctx);
  const inner = inlineToHtml(p, ctx);
  const attrStr = info.styles.length ? ` style="${info.styles.join(";")}"` : "";
  const anchorClass = [...p.getElementsByTagName("*")].some((node) =>
    node.localName === "shape" && vmlStyleMap(node).get("position") === "absolute")
    ? ' class="ooxml-anchor-container"' : "";
  let html = "";
  if (info.pageBreakBefore || inner.pageBreak) html += `<p class="page-break"><br></p>`;
  html += `<${info.tag}${anchorClass}${attrStr}>${inner.html || "<br>"}</${info.tag}>`;
  return html;
}

// Extract visible header/footer content while retaining PAGE/NUMPAGES positions.
// Complex fields cache their last result between `separate` and `end`; that
// cached number is skipped and represented by a live placeholder instead.
function headerFooterParagraph(p) {
  let template = "", currentField = null, inFieldResult = false;
  let hasPageField = false, hasNumPagesField = false, fieldSwitch = null;
  const fieldToken = (instr) => {
    if (/\bNUMPAGES\b/i.test(instr)) {
      hasNumPagesField = true;
      return "{{NUMPAGES}}";
    }
    if (/\bPAGE\b/i.test(instr)) {
      hasPageField = true;
      if (/\\\*\s*roman/i.test(instr)) fieldSwitch = "roman";
      else if (/\\\*\s*alphabetic/i.test(instr)) fieldSwitch = "alpha";
      return "{{PAGE}}";
    }
    return "";
  };
  const emitCurrentField = () => {
    if (!currentField || currentField.emitted) return;
    template += fieldToken(currentField.instr);
    currentField.emitted = true;
  };
  for (const node of p.children) {
    if (node.namespaceURI !== W) continue;
    if (node.localName === "fldSimple") {
      template += fieldToken(attr(node, "instr") || "");
      continue;
    }
    if (node.localName !== "r") continue;
    const fldChar = child(node, W, "fldChar");
    if (fldChar) {
      const type = attr(fldChar, "fldCharType");
      if (type === "begin") { currentField = { instr: "", emitted: false }; inFieldResult = false; }
      else if (type === "separate") { emitCurrentField(); inFieldResult = true; }
      else if (type === "end") { emitCurrentField(); currentField = null; inFieldResult = false; }
      continue;
    }
    const instrEl = child(node, W, "instrText");
    if (instrEl) {
      if (!currentField) currentField = { instr: "", emitted: false };
      currentField.instr += instrEl.textContent;
      continue;
    }
    if (inFieldResult) continue;
    for (const t of children(node, W, "t")) template += t.textContent;
    if (child(node, W, "tab")) template += "\t";
    if (child(node, W, "br")) template += "\n";
  }
  emitCurrentField();
  return { template, hasPageField, hasNumPagesField, fieldSwitch };
}

function appendChromeZone(zones, align, value) {
  const text = (value || "").trim();
  if (!text) return;
  zones[align] = zones[align] ? zones[align] + "\n" + text : text;
}

function parseHeaderFooterPart(xmlText) {
  if (!xmlText) return null;
  let doc;
  try { doc = parseXml(xmlText); } catch { return null; }
  const root = doc.documentElement;
  const zones = { left: "", center: "", right: "" };
  let hasPageField = false, pageFormat = "arabic", pageAlign = "left";
  for (const p of children(root, W, "p")) {
    const info = paragraphStyleInfo(p, {});
    const alignStyle = info.styles.find((s) => s.startsWith("text-align:"));
    const align = alignStyle ? alignStyle.split(":")[1] : "left";
    const seg = headerFooterParagraph(p);
    if (seg.hasPageField) {
      hasPageField = true;
      const pageAt = seg.template.indexOf("{{PAGE}}");
      const beforePage = pageAt >= 0 ? seg.template.slice(0, pageAt) : seg.template;
      const tabParts = beforePage.split("\t");
      // Word commonly lays out footer zones with tab stops: text before the
      // first tab is left, PAGE after one tab is centered, after two is right.
      pageAlign = tabParts.length > 2 ? "right" : tabParts.length > 1 ? "center" : align;
      for (let i = 0; i < tabParts.length - 1; i++) {
        appendChromeZone(zones, i === 0 ? "left" : "center", tabParts[i]);
      }
      const pageCellText = (tabParts[tabParts.length - 1] || "").replace(/\bPage\s*$/i, "");
      appendChromeZone(zones, pageAlign, pageCellText);
      if (seg.hasNumPagesField) pageFormat = "pageOfN";
      else if (seg.fieldSwitch) pageFormat = seg.fieldSwitch;
      else if (/\bPage\s*$/i.test(tabParts[tabParts.length - 1] || "")) pageFormat = "page";
      else pageFormat = "arabic";

      // Text after NUMPAGES/PAGE is usually either part of the number label or
      // a right-aligned footer label padded with tabs/spaces. Keep the latter.
      const lastToken = seg.hasNumPagesField ? "{{NUMPAGES}}" : "{{PAGE}}";
      const tokenAt = seg.template.lastIndexOf(lastToken);
      const afterField = tokenAt >= 0 ? seg.template.slice(tokenAt + lastToken.length) : "";
      const rightMatch = afterField.match(/(?:\t|\s{3,})(\S(?:[\s\S]*?\S)?)\s*$/);
      if (rightMatch) appendChromeZone(zones, "right", rightMatch[1]);
      continue;
    }
    appendChromeZone(zones, align, seg.template);
  }
  const populated = Object.entries(zones).filter(([, value]) => value);
  const align = populated.length === 1 ? populated[0][0] : "left";
  const text = populated.length === 1 ? populated[0][1] : "";
  return { text, align, zones, hasPageField, pageFormat, pageAlign };
}
function headerFooterRefs(sectPr) {
  const refs = { header: null, footer: null };
  for (const ref of children(sectPr, W, "headerReference")) {
    const type = attr(ref, "type") || "default";
    const rId = ref.getAttributeNS(R, "id") ?? ref.getAttribute("r:id");
    if (rId && (type === "default" || !refs.header)) refs.header = rId;
  }
  for (const ref of children(sectPr, W, "footerReference")) {
    const type = attr(ref, "type") || "default";
    const rId = ref.getAttributeNS(R, "id") ?? ref.getAttribute("r:id");
    if (rId && (type === "default" || !refs.footer)) refs.footer = rId;
  }
  return refs;
}
function resolveRelTarget(ctx, rId) {
  const rel = rId && ctx.rels.get(rId);
  if (!rel) return null;
  // targets in document.xml.rels are relative to word/
  const clean = rel.target.replace(/^\/?word\//, "").replace(/^\.\.?\//, "");
  return decodePart(ctx.files, "word/" + clean);
}
function parseSectPr(sectPr, ctx) {
  const setup = JSON.parse(JSON.stringify(DEFAULT_PAGE_SETUP));
  const pgSz = child(sectPr, W, "pgSz");
  if (pgSz) {
    const w = parseInt(pgSz.getAttributeNS(W, "w") ?? pgSz.getAttribute("w:w"), 10) || 12240;
    const h = parseInt(pgSz.getAttributeNS(W, "h") ?? pgSz.getAttribute("w:h"), 10) || 15840;
    const orient = pgSz.getAttributeNS(W, "orient") ?? pgSz.getAttribute("w:orient");
    // pgSz width/height describe the physical sheet.  Some Word producers
    // incorrectly leave orient="landscape" on portrait dimensions (or the
    // reverse). Trust the dimensions when they are unambiguous and use the
    // attribute only for a square/custom sheet.  Normalising to portrait
    // dimensions also lets A4/Letter recognition work in either orientation.
    setup.orientation = w > h ? "landscape" : h > w ? "portrait"
      : (orient === "landscape" ? "landscape" : "portrait");
    const portraitW = Math.min(w, h);
    const portraitH = Math.max(w, h);
    setup.size = "Letter";
    for (const [name, dim] of Object.entries(PAGE_SIZES)) {
      if (Math.abs(dim.w - portraitW) < 30 && Math.abs(dim.h - portraitH) < 30) { setup.size = name; break; }
    }
  }
  const pgMar = child(sectPr, W, "pgMar");
  if (pgMar) {
    for (const side of ["top", "right", "bottom", "left"]) {
      const v = parseInt(pgMar.getAttributeNS(W, side) ?? pgMar.getAttribute("w:" + side), 10);
      if (v >= 0) setup.margins[side] = Math.round((v / 1440) * 100) / 100;
    }
    // distance-from-edge for header/footer text, independent of the content
    // margin — read here so export can round-trip the real value instead of
    // the hardcoded 0.5in it used to always write regardless of the source.
    const hd = parseInt(pgMar.getAttributeNS(W, "header") ?? pgMar.getAttribute("w:header"), 10);
    const ft = parseInt(pgMar.getAttributeNS(W, "footer") ?? pgMar.getAttribute("w:footer"), 10);
    if (hd >= 0) setup.headerDistance = Math.round((hd / 1440) * 100) / 100;
    if (ft >= 0) setup.footerDistance = Math.round((ft / 1440) * 100) / 100;
  }
  if (ctx) {
    const refs = headerFooterRefs(sectPr);
    const chrome = {};
    if (refs.header) {
      const part = parseHeaderFooterPart(resolveRelTarget(ctx, refs.header));
      if (part && Object.values(part.zones).some(Boolean)) chrome.header = { text: part.text, align: part.align, zones: part.zones };
      if (part && part.hasPageField) chrome.pageNumber = { enabled: true, format: part.pageFormat, place: `header-${part.pageAlign}` };
    }
    if (refs.footer) {
      const part = parseHeaderFooterPart(resolveRelTarget(ctx, refs.footer));
      if (part && Object.values(part.zones).some(Boolean)) chrome.footer = { text: part.text, align: part.align, zones: part.zones };
      if (part && part.hasPageField) chrome.pageNumber = { enabled: true, format: part.pageFormat, place: `footer-${part.pageAlign}` };
    }
    if (Object.keys(chrome).length) setup.chrome = chrome;
  }
  return setup;
}

export async function importDocx(fileOrBuffer) {
  const buf = fileOrBuffer.arrayBuffer ? await fileOrBuffer.arrayBuffer() : fileOrBuffer;
  const files = await unzip(buf);
  const docXmlText = decodePart(files, "word/document.xml");
  if (!docXmlText) throw new Error("Not a valid .docx (no word/document.xml)");
  const ctx = {
    files,
    rels: parseRels(files, "word/_rels/document.xml.rels"),
    numFmt: parseNumbering(files),
    styleNumbering: parseStylesNumbering(files),
    comments: parseComments(files),
  };
  const doc = parseXml(docXmlText);
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("Malformed document.xml");

  // First pass: flat list of blocks, list items tagged with (numId, ilvl).
  const items = [];
  const listCounters = new Map();
  function nextListOrdinal(numId, ilvl, start) {
    const key = `${numId}:${ilvl}`;
    const value = listCounters.has(key) ? listCounters.get(key) + 1 : start;
    listCounters.set(key, value);
    for (const otherKey of [...listCounters.keys()]) {
      const separator = otherKey.lastIndexOf(":");
      if (otherKey.slice(0, separator) === String(numId)
          && Number(otherKey.slice(separator + 1)) > ilvl) listCounters.delete(otherKey);
    }
    return value;
  }
  let pageSetup = null;
  for (const node of body.children) {
    if (node.namespaceURI === MATH || node.localName === "oMathPara") {
      items.push({ html: `<p>${complexObjectHtml(node, ctx, serializeXmlNode(node))}</p>` });
      continue;
    }
    if (node.namespaceURI !== W) continue;
    if (node.localName === "p") {
      const info = paragraphStyleInfo(node, ctx);
      if (info.numId != null && ctx.numFmt.has(info.numId)) {
        const level = (ctx.numFmt.get(info.numId) || {})[String(info.ilvl)] || { fmt: "decimal", start: 1 };
        const inner = inlineToHtml(node, ctx);
        items.push({
          li: true, ilvl: Math.min(info.ilvl, 8), numId: info.numId,
          ordinal: nextListOrdinal(info.numId, info.ilvl, level.start),
          tag: level.fmt === "bullet" ? "ul" : "ol", html: inner.html || "<br>",
        });
      } else if (info.listTag) {
        const inner = inlineToHtml(node, ctx);
        items.push({ li: true, ilvl: Math.min(info.ilvl, 8), tag: info.listTag, html: inner.html || "<br>" });
      } else {
        items.push({ html: renderParagraph(node, ctx) });
      }
    } else if (node.localName === "tbl") {
      items.push({ html: tableToHtml(node, ctx) });
    } else if (node.localName === "sectPr") {
      pageSetup = parseSectPr(node, ctx);
    }
  }

  // Second pass: assemble nested lists.
  let html = "";
  const stack = [];
  const closeOne = () => { html += `</${stack.pop().tag}>`; };
  for (const item of items) {
    if (!item.li) {
      while (stack.length) closeOne();
      html += item.html;
      continue;
    }
    while (stack.length > item.ilvl + 1) closeOne();
    if (stack.length === item.ilvl + 1) {
      const current = stack[stack.length - 1];
      if (current.tag !== item.tag || current.numId !== item.numId) closeOne();
    }
    while (stack.length < item.ilvl + 1) {
      const atItemLevel = stack.length === item.ilvl;
      const start = atItemLevel && item.tag === "ol" && item.ordinal > 1 ? ` start="${item.ordinal}"` : "";
      html += `<${item.tag}${start}>`;
      stack.push({ tag: item.tag, numId: item.numId });
    }
    html += `<li>${item.html}</li>`;
  }
  while (stack.length) closeOne();

  // document title from core.xml
  let title = null;
  const coreText = decodePart(files, "docProps/core.xml");
  if (coreText) {
    try {
      const core = parseXml(coreText);
      const t = core.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0];
      if (t && t.textContent.trim()) title = t.textContent.trim();
    } catch {}
  }

  // comments -> the editor's client-side format
  const comments = [...ctx.comments.entries()].map(([id, c]) => ({
    id: "c" + id,
    author: c.author || "Unknown",
    text: c.text || "",
    createdAt: c.date ? (Date.parse(c.date) || Date.now()) : Date.now(),
    resolved: false,
    replies: [],
  }));

  return { html, pageSetup: pageSetup || { ...DEFAULT_PAGE_SETUP }, title, comments };
}

// Back-compat wrapper.
export async function readDocxHtml(file) {
  return (await importDocx(file)).html;
}

// ============================================================
// EXPORT: HTML -> .docx package
// ============================================================

function parseInlineStyle(style) {
  const o = {};
  if (!style) return o;
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k) o[k] = v;
  }
  return o;
}
const NAMED_COLORS = { black:"000000", white:"ffffff", red:"ff0000", blue:"0000ff", green:"008000", yellow:"ffff00", cyan:"00ffff", magenta:"ff00ff", gray:"808080", grey:"808080", silver:"c0c0c0", maroon:"800000", olive:"808000", purple:"800080", teal:"008080", navy:"000080", orange:"ffa500", lime:"00ff00", aqua:"00ffff", fuchsia:"ff00ff" };
function cssColorToHex(v) {
  if (!v) return null;
  v = v.trim().toLowerCase();
  if (v === "transparent" || v === "inherit" || v === "initial") return null;
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    return h.length === 6 ? h : null;
  }
  const rgb = v.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(",").map(s => parseFloat(s.trim()));
    if (parts.length === 4 && parts[3] === 0) return null;
    if (parts.length >= 3) return parts.slice(0, 3).map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");
  }
  return NAMED_COLORS[v] || null;
}
function cssSizeToHalfPoints(v) {
  if (!v) return null;
  let m = v.match(/([\d.]+)\s*pt/);
  if (m) return Math.round(parseFloat(m[1]) * 2);
  m = v.match(/([\d.]+)\s*px/);
  if (m) return Math.round(parseFloat(m[1]) * 1.5);
  m = v.match(/([\d.]+)\s*em/);
  if (m) return Math.round(parseFloat(m[1]) * 22);
  return null;
}
function cssLenToTwips(v) {
  if (!v) return null;
  let m = String(v).match(/(-?[\d.]+)\s*px/);
  if (m) return Math.round(parseFloat(m[1]) * TW_PER_PX);
  m = String(v).match(/(-?[\d.]+)\s*pt/);
  if (m) return Math.round(parseFloat(m[1]) * 20);
  m = String(v).match(/(-?[\d.]+)\s*in/);
  if (m) return Math.round(parseFloat(m[1]) * 1440);
  return null;
}

// ---- runs ----
function spanProps(el, props) {
  const np = { ...props };
  const st = parseInlineStyle(el.getAttribute("style") || "");
  if (st["color"]) np.color = cssColorToHex(st["color"]) || np.color;
  if (st["background-color"]) {
    const h = cssColorToHex(st["background-color"]);
    if (h) np.highlight = h;
  }
  const sz = cssSizeToHalfPoints(st["font-size"]);
  if (sz) np.sz = sz;
  if (st["font-family"]) np.font = st["font-family"].split(",")[0].replace(/['"]/g, "").trim();
  if (st["font-weight"] === "bold" || parseInt(st["font-weight"], 10) >= 600) np.b = true;
  if (st["font-weight"] === "normal") np.b = false;
  if (st["font-style"] === "italic") np.i = true;
  const td = st["text-decoration"] || st["text-decoration-line"] || "";
  if (td.includes("underline")) np.u = true;
  if (td.includes("line-through")) np.s = true;
  if (st["vertical-align"] === "super") np.sup = true;
  if (st["vertical-align"] === "sub") np.sub = true;
  return np;
}

function collectRuns(node, props, runs) {
  for (const kid of node.childNodes) {
    if (kid.nodeType === 3) {
      const t = kid.textContent;
      if (t !== "") runs.push({ ...props, text: t });
      continue;
    }
    if (kid.nodeType !== 1) continue;
    const el = kid;
    const tag = el.tagName.toLowerCase();
    if (tag === "span" && el.classList.contains("ooxml-object")) {
      const rawOoxml = base64ToUtf8(el.getAttribute("data-ooxml") || "");
      // Only XML fragments created by the importer are accepted.  Reject XML
      // declarations/DTDs and limit roots to the inline structures we emit.
      if (rawOoxml && !/<\?(?:xml)|<!DOCTYPE/i.test(rawOoxml)
          && /^\s*<(?:w:r\b|m:oMath(?:Para)?\b|mc:AlternateContent\b)/.test(rawOoxml)) {
        let normalizedOoxml = rawOoxml;
        try { normalizedOoxml = serializeXmlNode(parseXml(rawOoxml).documentElement); }
        catch { /* Keep the importer's validated fragment if normalization is unnecessary. */ }
        runs.push({ ...props, rawOoxml: normalizedOoxml });
      }
      continue;
    }
    let np = { ...props };
    if (tag === "b" || tag === "strong") np.b = true;
    else if (tag === "i" || tag === "em") np.i = true;
    else if (tag === "ins") {
      // tracked insertion (review) vs plain <ins> (underline)
      if (el.classList.contains("tc-ins")) {
        np.ins = { author: el.getAttribute("data-author") || "Author", date: el.getAttribute("data-ts") || "" };
      } else np.u = true;
    }
    else if (tag === "u") np.u = true;
    else if (tag === "del") {
      if (el.classList.contains("tc-del")) {
        np.del = { author: el.getAttribute("data-author") || "Author", date: el.getAttribute("data-ts") || "" };
      } else np.s = true;
    }
    else if (tag === "s" || tag === "strike") np.s = true;
    else if (tag === "sub") np.sub = true;
    else if (tag === "sup") np.sup = true;
    else if (tag === "mark") np.highlight = np.highlight || "ffff00";
    else if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") np.font = "Courier New";
    else if (tag === "br") { runs.push({ ...props, br: true, pb: el.classList.contains("pb") }); continue; }
    else if (tag === "img") { runs.push({ ...props, img: el }); continue; }
    else if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && /^(https?:|mailto:)/i.test(href)) np.link = href;
    }
    else if (tag === "span" || tag === "font") {
      if (el.classList && el.classList.contains("comment-ref")) {
        const cid = el.getAttribute("data-cid");
        if (cid) np.cmt = cid;
      }
      const face = el.getAttribute("face");
      if (face) np.font = face;
      const size = el.getAttribute("size");
      if (size) np.sz = (parseInt(size, 10) * 2 + 12) || np.sz;
      const fcolor = el.getAttribute("color");
      if (fcolor) np.color = cssColorToHex(fcolor) || np.color;
    }
    if (el.getAttribute && el.getAttribute("style")) np = spanProps(el, np);
    collectRuns(el, np, runs);
  }
}

function runPropsXml(run, opts = {}) {
  const rPr = [];
  if (opts.hyperlink) rPr.push(`<w:rStyle w:val="Hyperlink"/>`);
  if (run.font) rPr.push(`<w:rFonts w:ascii="${escXml(run.font)}" w:hAnsi="${escXml(run.font)}"/>`);
  if (run.b) rPr.push(`<w:b/>`);
  if (run.i) rPr.push(`<w:i/>`);
  if (run.s) rPr.push(`<w:strike/>`);
  if (run.color) rPr.push(`<w:color w:val="${escXml(run.color)}"/>`);
  if (run.sz) rPr.push(`<w:sz w:val="${run.sz}"/><w:szCs w:val="${run.sz}"/>`);
  if (run.highlight) {
    const named = HEX_TO_HIGHLIGHT[run.highlight.toLowerCase()];
    if (named) rPr.push(`<w:highlight w:val="${named}"/>`);
    else rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${escXml(run.highlight)}"/>`);
  }
  if (run.u) rPr.push(`<w:u w:val="single"/>`);
  if (run.sub) rPr.push(`<w:vertAlign w:val="subscript"/>`);
  if (run.sup) rPr.push(`<w:vertAlign w:val="superscript"/>`);
  return rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
}

function imageRunXml(run, ctx) {
  const media = ctx.images.get(run.img);
  if (!media) return "";
  const cx = Math.max(1, Math.round(media.w * EMU_PER_PX));
  const cy = Math.max(1, Math.round(media.h * EMU_PER_PX));
  const id = media.docPrId;
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}">` +
    `<pic:pic xmlns:pic="${PIC}">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${media.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function runToXml(run, ctx, opts = {}) {
  if (run.rawOoxml) return run.rawOoxml;
  if (run.img) return imageRunXml(run, ctx);
  if (run.br) return run.pb ? `<w:r><w:br w:type="page"/></w:r>` : `<w:r><w:br/></w:r>`;
  // deleted runs must use w:delText instead of w:t
  const tTag = run.del ? "w:delText" : "w:t";
  return `<w:r>${runPropsXml(run, opts)}<${tTag} xml:space="preserve">${escXml(run.text)}</${tTag}></w:r>`;
}

// Groups consecutive runs sharing the same link into w:hyperlink wrappers.
function linkGroupToXml(runs, ctx) {
  let out = "";
  let i = 0;
  while (i < runs.length) {
    const link = runs[i].link;
    if (!link) { out += runToXml(runs[i], ctx); i++; continue; }
    let j = i;
    let inner = "";
    while (j < runs.length && runs[j].link === link) {
      inner += runToXml(runs[j], ctx, { hyperlink: !runs[j].img });
      j++;
    }
    let relId = ctx.hrefRels.get(link);
    if (!relId) {
      relId = "rId" + ctx.nextRelId++;
      ctx.hrefRels.set(link, relId);
      ctx.rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escXml(link)}" TargetMode="External"/>`);
    }
    out += `<w:hyperlink r:id="${relId}">${inner}</w:hyperlink>`;
    i = j;
  }
  return out;
}

// Full inline serialization: comment range markers (milestones) outermost,
// tracked-change wrappers (w:ins / w:del) next, hyperlinks innermost.
function runsToXml(runs, ctx) {
  let out = "";
  let openCmt = null;
  const closeCmt = () => {
    const id = ctx.commentId(openCmt);
    out += `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
    openCmt = null;
  };
  let i = 0;
  while (i < runs.length) {
    const r = runs[i];
    const cmt = r.cmt && ctx.commentId(r.cmt) != null ? r.cmt : null;
    if (cmt !== openCmt) {
      if (openCmt) closeCmt();
      if (cmt) { out += `<w:commentRangeStart w:id="${ctx.commentId(cmt)}"/>`; openCmt = cmt; }
    }
    const kind = r.ins ? "ins" : r.del ? "del" : "";
    const kindKey = kind ? JSON.stringify(r[kind]) : "";
    let j = i + 1;
    while (j < runs.length) {
      const rj = runs[j];
      const cmtJ = rj.cmt && ctx.commentId(rj.cmt) != null ? rj.cmt : null;
      if (cmtJ !== cmt) break;
      const kindJ = rj.ins ? "ins" : rj.del ? "del" : "";
      if (kindJ !== kind) break;
      if (kind && JSON.stringify(rj[kind]) !== kindKey) break;
      j++;
    }
    const inner = linkGroupToXml(runs.slice(i, j), ctx);
    if (kind) {
      const meta = r[kind];
      out += `<w:${kind} w:id="${ctx.revId++}" w:author="${escXml(meta.author || "Author")}" w:date="${tsIso(meta.date)}">${inner}</w:${kind}>`;
    } else {
      out += inner;
    }
    i = j;
  }
  if (openCmt) closeCmt();
  return out;
}

// ---- paragraphs / blocks ----
function paragraphPropsXml(el, extra = []) {
  const pPr = [...extra];
  const st = el.style || {};
  const align = st.textAlign || el.getAttribute("align");
  if (align === "left" || align === "start") pPr.push(`<w:jc w:val="left"/>`);
  else if (align === "center") pPr.push(`<w:jc w:val="center"/>`);
  else if (align === "right" || align === "end") pPr.push(`<w:jc w:val="right"/>`);
  else if (align === "justify") pPr.push(`<w:jc w:val="both"/>`);
  const indParts = [];
  const ml = cssLenToTwips(st.marginLeft);
  if (ml) indParts.push(`w:left="${ml}"`);
  const ti = cssLenToTwips(st.textIndent);
  if (ti > 0) indParts.push(`w:firstLine="${ti}"`);
  else if (ti < 0) indParts.push(`w:hanging="${-ti}"`);
  if (indParts.length) pPr.push(`<w:ind ${indParts.join(" ")}/>`);
  const lh = parseFloat(st.lineHeight);
  if (lh && !String(st.lineHeight).match(/px|pt/) && lh > 0 && lh < 10) {
    pPr.push(`<w:spacing w:line="${Math.round(lh * 240)}" w:lineRule="auto"/>`);
  }
  return pPr;
}

// contentEditable represents an empty paragraph as <p><br></p>; that trailing
// br is a placeholder, not a real line break.
function stripPlaceholderBr(runs) {
  if (runs.length && runs[runs.length - 1].br && !runs[runs.length - 1].pb) {
    const hasText = runs.some((r) => (r.text && r.text.trim()) || r.img);
    if (!hasText) runs.pop();
  }
  return runs;
}

function paragraphToXml(el, ctx, extraPPr = []) {
  const pPr = paragraphPropsXml(el, extraPPr);
  const runs = [];
  collectRuns(el, {}, runs);
  stripPlaceholderBr(runs);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
  return `<w:p>${pPrXml}${runsToXml(runs, ctx)}</w:p>`;
}

function listToXml(listEl, ctx, ilvl, numId) {
  const tag = listEl.tagName.toLowerCase();
  if (numId == null) {
    if (tag === "ol") {
      numId = ctx.nextNumId++;
      const start = parseInt(listEl.getAttribute("start"), 10) || 1;
      ctx.nums.push({ numId, abstract: 1, start, ilvl: Math.min(ilvl, 8) });
    }
    else numId = 1; // shared bullet numbering
  }
  let out = "";
  for (const li of listEl.children) {
    const t = li.tagName.toLowerCase();
    if (t === "ul" || t === "ol") { out += listToXml(li, ctx, Math.min(ilvl + 1, 8), t === tag ? numId : null); continue; }
    if (t !== "li") continue;
    // split direct inline content from nested lists
    const nested = [];
    const clone = li.cloneNode(true);
    for (const sub of [...clone.children]) {
      const st = sub.tagName.toLowerCase();
      if (st === "ul" || st === "ol") { clone.removeChild(sub); }
    }
    const runs = [];
    collectRuns(clone, {}, runs);
    stripPlaceholderBr(runs);
    const numPr = `<w:numPr><w:ilvl w:val="${Math.min(ilvl, 8)}"/><w:numId w:val="${numId}"/></w:numPr>`;
    const pPr = paragraphPropsXml(li, [`<w:pStyle w:val="ListParagraph"/>`, numPr]);
    out += `<w:p><w:pPr>${pPr.join("")}</w:pPr>${runsToXml(runs, ctx)}</w:p>`;
    for (const sub of li.children) {
      const st = sub.tagName.toLowerCase();
      if (st === "ul" || st === "ol") nested.push(sub);
    }
    for (const sub of nested) out += listToXml(sub, ctx, Math.min(ilvl + 1, 8), sub.tagName.toLowerCase() === tag ? numId : null);
  }
  return out;
}

function tableToXml(tableEl, ctx) {
  // Build grid model from the HTML table, honoring colspan/rowspan.
  const trs = [...tableEl.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr")];
  if (!trs.length) return "";
  const grid = []; // grid[row][col] = {cell, origin:bool} | undefined
  let nCols = 0;
  trs.forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const cell of tr.children) {
      const t = cell.tagName.toLowerCase();
      if (t !== "td" && t !== "th") continue;
      while (grid[r][c] !== undefined) c++;
      const colspan = Math.max(1, parseInt(cell.getAttribute("colspan"), 10) || 1);
      const rowspan = Math.max(1, parseInt(cell.getAttribute("rowspan"), 10) || 1);
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] = grid[r + dr] || [];
        for (let dc = 0; dc < colspan; dc++) {
          grid[r + dr][c + dc] = { cell, origin: dr === 0 && dc === 0, top: dr === 0, colspan };
        }
      }
      c += colspan;
      nCols = Math.max(nCols, c);
    }
    nCols = Math.max(nCols, grid[r].length);
  });
  if (!nCols) return "";
  const colW = Math.floor(9360 / nCols);
  let xml = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>` +
    `</w:tblPr><w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(nCols)}</w:tblGrid>`;
  for (let r = 0; r < grid.length; r++) {
    xml += "<w:tr>";
    let c = 0;
    while (c < nCols) {
      const slot = grid[r][c];
      if (!slot) { // empty filler cell
        xml += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
        c++;
        continue;
      }
      const { cell, origin, top, colspan } = slot;
      const tcPr = [`<w:tcW w:w="${colW * colspan}" w:type="dxa"/>`];
      if (colspan > 1) tcPr.push(`<w:gridSpan w:val="${colspan}"/>`);
      const rowspan = Math.max(1, parseInt(cell.getAttribute("rowspan"), 10) || 1);
      if (rowspan > 1) tcPr.push(origin ? `<w:vMerge w:val="restart"/>` : `<w:vMerge/>`);
      const bg = cssColorToHex((cell.style && cell.style.backgroundColor) || cell.getAttribute("bgcolor") || "");
      if (bg && (origin || top)) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>`);
      let content = "";
      if (origin) {
        const isTh = cell.tagName.toLowerCase() === "th";
        const blocks = blockChildren(cell);
        if (blocks.length) content = blocks.map((b) => blockToXml(b, ctx)).join("");
        else if (isTh) {
          const runs = [];
          collectRuns(cell, { b: true }, runs);
          stripPlaceholderBr(runs);
          content = `<w:p>${runsToXml(runs, ctx)}</w:p>`;
        } else {
          content = paragraphToXml(cell, ctx);
        }
        if (!content.endsWith("</w:p>") && !content.endsWith("<w:p/>")) content += "<w:p/>"; // tc must end with a paragraph
      } else {
        content = "<w:p/>";
      }
      xml += `<w:tc><w:tcPr>${tcPr.join("")}</w:tcPr>${content || "<w:p/>"}</w:tc>`;
      c += colspan;
    }
    xml += "</w:tr>";
  }
  return xml + "</w:tbl>";
}

const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "pre", "hr", "li", "section", "article", "figure"]);
function blockChildren(el) {
  const out = [];
  for (const c of el.children) {
    if (BLOCK_TAGS.has(c.tagName.toLowerCase())) out.push(c);
  }
  // only treat as block container if ALL meaningful content is in blocks
  if (!out.length) return [];
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent.trim()) return [];
    if (n.nodeType === 1 && !BLOCK_TAGS.has(n.tagName.toLowerCase()) && n.textContent.trim()) return [];
  }
  return out;
}

function blockToXml(el, ctx) {
  const tag = el.tagName.toLowerCase();
  if (el.classList && el.classList.contains("page-break")) {
    return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }
  if (/^h[1-6]$/.test(tag)) {
    return paragraphToXml(el, ctx, [`<w:pStyle w:val="Heading${tag[1]}"/>`]);
  }
  if (tag === "blockquote") {
    const blocks = blockChildren(el);
    if (blocks.length) return blocks.map((b) => paragraphToXml(b, ctx, [`<w:pStyle w:val="Quote"/>`])).join("");
    return paragraphToXml(el, ctx, [`<w:pStyle w:val="Quote"/>`]);
  }
  if (tag === "ul" || tag === "ol") return listToXml(el, ctx, 0, null);
  if (tag === "table") return tableToXml(el, ctx);
  if (tag === "hr") {
    return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`;
  }
  if (tag === "pre") {
    const lines = el.textContent.split("\n");
    return lines.map((ln) =>
      `<w:p><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escXml(ln)}</w:t></w:r></w:p>`
    ).join("");
  }
  // p / div / other containers
  const blocks = blockChildren(el);
  if (blocks.length) return blocks.map((b) => blockToXml(b, ctx)).join("");
  return paragraphToXml(el, ctx);
}

// ---- image collection (async: sizes + bytes) ----
async function collectImages(container, ctx) {
  const imgs = [...container.querySelectorAll("img")].filter((img) => !img.closest(".ooxml-object"));
  let n = 0;
  for (const img of imgs) {
    try {
      const src = img.getAttribute("src") || "";
      let bytes, mime;
      if (src.startsWith("data:")) {
        ({ bytes, mime } = dataUrlToBytes(src));
      } else if (src) {
        const resp = await fetch(src);
        const blob = await resp.blob();
        mime = blob.type || "image/png";
        bytes = new Uint8Array(await blob.arrayBuffer());
      } else continue;
      let ext = Object.entries(IMG_MIME).find(([, m]) => m === mime)?.[0] || "png";
      if (ext === "jpeg") ext = "jpg";
      // dimensions: explicit attrs/styles win, else decode
      let w = parseFloat(img.getAttribute("width")) || parseFloat(img.style.width) || 0;
      let h = parseFloat(img.getAttribute("height")) || parseFloat(img.style.height) || 0;
      if (!w || !h) {
        const dims = await new Promise((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
          probe.onerror = () => resolve({ w: 300, h: 200 });
          probe.src = src;
        });
        if (!w && !h) { w = dims.w; h = dims.h; }
        else if (!h) h = w * (dims.h / dims.w || 0.66);
        else if (!w) w = h * (dims.w / dims.h || 1.5);
      }
      // cap at printable width (~6.5in @ 96dpi)
      const MAXW = 624;
      if (w > MAXW) { h = h * (MAXW / w); w = MAXW; }
      n++;
      const name = ctx.baseFiles ? uniqueWordPart(ctx, "editorImage", ext) : `image${n}.${ext}`;
      const relId = "rId" + ctx.nextRelId++;
      ctx.rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      ctx.media.push({ name, bytes, ext });
      ctx.images.set(img, { relId, w: Math.round(w), h: Math.round(h), docPrId: n });
    } catch (e) {
      console.warn("image export skipped:", e);
    }
  }
}

// ---- package parts ----
function decodeBytes(bytes) {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function relationshipMaxId(files) {
  const xml = decodeBytes(files && files.get("word/_rels/document.xml.rels"));
  let max = 9;
  for (const m of xml.matchAll(/\bId=["']rId(\d+)["']/g)) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

function uniqueWordPart(ctx, stem, ext) {
  let index = 1;
  let name;
  do { name = `${stem}${index++}.${ext}`; }
  while ((ctx.baseFiles && ctx.baseFiles.has(`word/${name}`))
    || ctx.media.some((m) => m.name === name)
    || ctx.headerFooterFiles.some((f) => f.name === name));
  return name;
}

function mergeXmlChildren(baseText, generatedText, keyFor) {
  if (!baseText) return generatedText;
  try {
    const base = parseXml(baseText);
    const generated = parseXml(generatedText);
    const root = base.documentElement;
    const seen = new Set([...root.children].map(keyFor).filter(Boolean));
    for (const node of generated.documentElement.children) {
      const key = keyFor(node);
      if (key && seen.has(key)) continue;
      root.appendChild(base.importNode(node, true));
      if (key) seen.add(key);
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${serializeXmlNode(root)}`;
  } catch {
    return generatedText;
  }
}

function contentTypesXml(ctx, baseText = "") {
  const exts = new Set(ctx.media.map((m) => m.ext));
  let defaults = "";
  for (const e of exts) {
    const mime = IMG_MIME[e === "jpg" ? "jpeg" : e] || "image/" + e;
    defaults += `<Default Extension="${e}" ContentType="${mime}"/>`;
  }
  const commentsOverride = ctx.commentIds.size
    ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`
    : "";
  const chromeOverrides = (ctx.headerFooterFiles || []).map((f) =>
    `<Override PartName="/word/${f.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${f.name.startsWith("header") ? "header" : "footer"}+xml"/>`
  ).join("");
  const generated = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` + defaults +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    commentsOverride + chromeOverrides +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;
  return mergeXmlChildren(baseText, generated, (node) =>
    node.localName === "Default" ? `D:${node.getAttribute("Extension")}`
      : node.localName === "Override" ? `O:${node.getAttribute("PartName")}` : "");
}

const PKG_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

function docRelsXml(ctx, baseText = "") {
  const stylesId = baseText ? `rId${ctx.nextRelId++}` : "rId1";
  const numberingId = baseText ? `rId${ctx.nextRelId++}` : "rId2";
  const commentsId = baseText ? `rId${ctx.nextRelId++}` : "rId3";
  const commentsRel = ctx.commentIds.size
    ? `<Relationship Id="${commentsId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`
    : "";
  const generated = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="${numberingId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
    commentsRel +
    ctx.rels.join("") +
    `</Relationships>`;
  return mergeXmlChildren(baseText, generated, (node) => {
    const type = node.getAttribute("Type") || "";
    // styles/numbering/comments are singleton semantic relationships; newly
    // allocated image/link/header relationships are keyed by their unique Id.
    if (/\/(?:styles|numbering|comments)$/.test(type)) return `T:${type}`;
    return `I:${node.getAttribute("Id")}`;
  });
}

function commentsXml(ctx) {
  let out = "";
  for (const [cid, num] of ctx.commentIds) {
    const c = ctx.commentMeta.get(cid) || {};
    const paras = [c.text || "", ...((c.replies || []).map((r) => `${r.author || "?"}: ${r.text || ""}`))].filter(Boolean);
    const body = paras.map((t) =>
      t.split("\n").map((ln) => `<w:p><w:r><w:t xml:space="preserve">${escXml(ln)}</w:t></w:r></w:p>`).join("")
    ).join("") || "<w:p/>";
    out += `<w:comment w:id="${num}" w:author="${escXml(c.author || "Unknown")}" w:date="${tsIso(c.createdAt)}" w:initials="${escXml(String(c.author || "?").slice(0, 2).toUpperCase())}">${body}</w:comment>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:comments xmlns:w="${W}">${out}</w:comments>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="2F5496"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="2F5496"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="2F5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="80" w:after="40"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:i/><w:color w:val="2F5496"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="80" w:after="40"/><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="2F5496"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="160"/><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const BULLET_GLYPHS = ["", "o", ""]; // Symbol bullet, Courier o, Wingdings square
const BULLET_FONTS = ["Symbol", "Courier New", "Wingdings"];
function numberingXml(ctx) {
  let bulletLvls = "", decimalLvls = "";
  for (let l = 0; l < 9; l++) {
    const ind = 720 * (l + 1);
    bulletLvls += `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${BULLET_GLYPHS[l % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="${BULLET_FONTS[l % 3]}" w:hAnsi="${BULLET_FONTS[l % 3]}" w:hint="default"/></w:rPr></w:lvl>`;
    const fmt = l % 3 === 0 ? "decimal" : l % 3 === 1 ? "lowerLetter" : "lowerRoman";
    decimalLvls += `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind}" w:hanging="360"/></w:pPr></w:lvl>`;
  }
  let nums = `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
  for (const n of ctx.nums) {
    const startOverride = n.start > 1
      ? `<w:lvlOverride w:ilvl="${n.ilvl || 0}"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : "";
    nums += `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstract}"/>${startOverride}</w:num>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="${W}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLvls}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimalLvls}</w:abstractNum>` +
    nums +
    `</w:numbering>`;
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escXml(title || "")}</dc:title>` +
    `<dc:creator>Word-Compat Editor</dc:creator>` +
    `<cp:lastModifiedBy>Word-Compat Editor</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    `</cp:coreProperties>`;
}
const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Word-Compat Editor</Application></Properties>`;

// Live PAGE (and NUMPAGES, for "page X of Y") field(s) as w:fldSimple —
// simpler to emit than the begin/instrText/separate/end complex-field form,
// and equally well supported by Word. The "1" is just the cached display
// value shown before a real Word instance recalculates fields on open; it's
// never what's actually rendered once opened for real.
function pageNumberFieldXml(format) {
  const fieldSwitch = { roman: " \\* roman", alpha: " \\* alphabetic" }[format] || "";
  const pageField = `<w:fldSimple w:instr="PAGE${fieldSwitch}"><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
  if (format === "page") return `<w:r><w:t xml:space="preserve">Page </w:t></w:r>${pageField}`;
  if (format === "pageOfN") {
    return `<w:r><w:t xml:space="preserve">Page </w:t></w:r>${pageField}` +
      `<w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
  }
  return pageField; // arabic (bare number) / roman / alpha
}
function jcXml(align) {
  return align === "center" ? '<w:jc w:val="center"/>' : align === "right" ? '<w:jc w:val="right"/>' : "";
}
function headerFooterTextXml(text) {
  return String(text || "").split("\n").map((line, index) =>
    `${index ? "<w:r><w:br/></w:r>" : ""}<w:r><w:t xml:space="preserve">${escXml(line)}</w:t></w:r>`
  ).join("");
}
// Emit the same left / center / right chrome model used on screen. Tab stops
// keep mixed footer labels and page-number fields on one line in Word, while
// embedded line breaks preserve multi-line headers.
function headerFooterPartXml(rootTag, textEntry, pageNumberEntry) {
  const paras = [];
  const zones = textEntry && textEntry.zones
    ? { left: textEntry.zones.left || "", center: textEntry.zones.center || "", right: textEntry.zones.right || "" }
    : { left: "", center: "", right: "" };
  if (textEntry && textEntry.text && !Object.values(zones).some(Boolean)) zones[textEntry.align || "center"] = textEntry.text;
  if (pageNumberEntry || Object.values(zones).filter(Boolean).length > 1) {
    const contents = {};
    for (const align of ["left", "center", "right"]) {
      contents[align] = headerFooterTextXml(zones[align]);
      if (pageNumberEntry && pageNumberEntry.align === align) {
        if (contents[align]) contents[align] += '<w:r><w:t xml:space="preserve">  </w:t></w:r>';
        contents[align] += pageNumberFieldXml(pageNumberEntry.format);
      }
    }
    const tabs = '<w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs>';
    paras.push(`<w:p><w:pPr>${tabs}</w:pPr>${contents.left}<w:r><w:tab/></w:r>${contents.center}<w:r><w:tab/></w:r>${contents.right}</w:p>`);
  } else if (textEntry && (textEntry.text || Object.values(zones).some(Boolean))) {
    const align = Object.keys(zones).find((key) => zones[key]) || textEntry.align || "left";
    paras.push(`<w:p><w:pPr>${jcXml(align)}</w:pPr>${headerFooterTextXml(zones[align] || textEntry.text)}</w:p>`);
  }
  if (!paras.length) paras.push("<w:p/>");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${rootTag} xmlns:w="${W}">${paras.join("")}</w:${rootTag}>`;
}
// Registers a header or footer part + relationship on ctx (mirrors how
// collectImages registers media rels) and returns the headerReference/
// footerReference XML fragment to splice into sectPr — or "" if this
// document has nothing to put in that slot.
function registerHeaderFooter(ctx, kind, chrome) {
  if (!ctx || !ctx.rels || !ctx.headerFooterFiles) return "";
  const pn = chrome.pageNumber && chrome.pageNumber.place && chrome.pageNumber.place.startsWith(kind)
    ? { format: chrome.pageNumber.format, align: chrome.pageNumber.place.slice(kind.length + 1) }
    : null;
  const textEntry = chrome[kind]; // chrome.header | chrome.footer
  if (!textEntry && !pn) return "";
  const partName = ctx.baseFiles
    ? uniqueWordPart(ctx, kind === "header" ? "headerEditor" : "footerEditor", "xml")
    : (kind === "header" ? "header1.xml" : "footer1.xml");
  const rootTag = kind === "header" ? "hdr" : "ftr";
  const relType = `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`;
  const relId = "rId" + ctx.nextRelId++;
  ctx.rels.push(`<Relationship Id="${relId}" Type="${relType}" Target="${partName}"/>`);
  ctx.headerFooterFiles.push({ name: partName, xml: headerFooterPartXml(rootTag, textEntry, pn) });
  const refTag = kind === "header" ? "headerReference" : "footerReference";
  return `<w:${refTag} w:type="default" r:id="${relId}"/>`;
}
function sectPrXml(setup, ctx) {
  const s = setup || DEFAULT_PAGE_SETUP;
  const dim = PAGE_SIZES[s.size] || PAGE_SIZES.Letter;
  let w = dim.w, h = dim.h;
  const landscape = s.orientation === "landscape";
  if (landscape) [w, h] = [h, w];
  const m = s.margins || DEFAULT_PAGE_SETUP.margins;
  const tw = (v) => Math.round((v != null ? v : 1) * 1440);
  // Round-trip the real header/footer distance-from-edge when we imported
  // one; otherwise Word's own default of 0.5in.
  const headerDist = tw(s.headerDistance != null ? s.headerDistance : 0.5);
  const footerDist = tw(s.footerDistance != null ? s.footerDistance : 0.5);
  const chrome = s.chrome;
  const refs = chrome
    ? registerHeaderFooter(ctx, "header", chrome) + registerHeaderFooter(ctx, "footer", chrome)
    : "";
  // headerReference/footerReference must precede pgSz per the CT_SectPr schema.
  return `<w:sectPr>${refs}<w:pgSz w:w="${w}" w:h="${h}"${landscape ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.right)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.left)}" w:header="${headerDist}" w:footer="${footerDist}" w:gutter="0"/></w:sectPr>`;
}

export function htmlToDocumentXml(html, ctx, pageSetup) {
  const container = document.createElement("div");
  container.innerHTML = html || "<p></p>";
  return domToDocumentXml(container, ctx, pageSetup);
}
function domToDocumentXml(container, ctx, pageSetup) {
  let body = "";
  const blocks = blockChildren(container);
  if (blocks.length) {
    for (const el of container.children) body += blockToXml(el, ctx);
  } else if (container.textContent.trim() || container.querySelector("img")) {
    body = paragraphToXml(container, ctx);
  }
  if (!body) body = `<w:p/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}">` +
    `<w:body>${body}${sectPrXml(pageSetup, ctx)}</w:body></w:document>`;
}

export async function buildDocxFromHtml(html, opts = {}) {
  const enc = new TextEncoder();
  let baseFiles = null;
  if (opts.baseDocx) {
    try { baseFiles = await unzip(opts.baseDocx); }
    catch (e) { console.warn("base DOCX could not be opened; exporting a new package:", e.message); }
  }
  const ctx = {
    rels: [], media: [], images: new Map(),
    hrefRels: new Map(), nextRelId: baseFiles ? relationshipMaxId(baseFiles) + 1 : 10,
    nums: [], nextNumId: 2,
    revId: 1,
    commentMeta: new Map((opts.comments || []).map((c) => [c.id, c])),
    commentIds: new Map(),
    headerFooterFiles: [],
    baseFiles,
  };
  ctx.commentId = (cid) => {
    if (!ctx.commentMeta.has(cid)) return null;
    if (!ctx.commentIds.has(cid)) ctx.commentIds.set(cid, ctx.commentIds.size);
    return ctx.commentIds.get(cid);
  };
  const container = document.createElement("div");
  container.innerHTML = html || "<p></p>";
  await collectImages(container, ctx);
  const documentXml = domToDocumentXml(container, ctx, opts.pageSetup);
  const files = baseFiles ? new Map(baseFiles) : new Map();
  files.set("[Content_Types].xml", enc.encode(contentTypesXml(ctx, decodeBytes(baseFiles && baseFiles.get("[Content_Types].xml")))));
  if (!files.has("_rels/.rels")) files.set("_rels/.rels", enc.encode(PKG_RELS));
  files.set("word/document.xml", enc.encode(documentXml));
  files.set("word/_rels/document.xml.rels", enc.encode(docRelsXml(ctx, decodeBytes(baseFiles && baseFiles.get("word/_rels/document.xml.rels")))));
  files.set("word/styles.xml", enc.encode(STYLES));
  files.set("word/numbering.xml", enc.encode(numberingXml(ctx)));
  files.set("docProps/core.xml", enc.encode(coreXml(opts.title)));
  files.set("docProps/app.xml", enc.encode(APP_XML));
  if (ctx.commentIds.size) files.set("word/comments.xml", enc.encode(commentsXml(ctx)));
  for (const f of ctx.headerFooterFiles) files.set("word/" + f.name, enc.encode(f.xml));
  for (const m of ctx.media) files.set("word/media/" + m.name, m.bytes);
  return zip(files);
}

// ============================================================
// Other formats
// ============================================================

export function htmlToPlainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const out = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out.push(c.textContent); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (tag === "br") { out.push("\n"); continue; }
      if (tag === "del" && c.classList.contains("tc-del")) continue; // deleted (tracked) text
      const isBlock = BLOCK_TAGS.has(tag) || tag === "tr";
      if (tag === "td" || tag === "th") { walk(c); out.push("\t"); continue; }
      walk(c);
      if (isBlock) out.push("\n");
    }
  };
  walk(div);
  return out.join("").replace(/\t\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function plainTextToHtml(text) {
  return String(text).split(/\r?\n/).map((ln) => `<p>${escHtml(ln) || "<br>"}</p>`).join("");
}

export function exportStandaloneHtml(html, title) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(title || "Document")}</title>
<style>
body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4;max-width:8.5in;margin:24px auto;padding:0 1in;color:#111}
table{border-collapse:collapse;width:100%;margin:8px 0}
td,th{border:1px solid #bbb;padding:4px 8px;vertical-align:top}
img{max-width:100%}
blockquote{border-left:3px solid #2b579a;margin-left:0;padding-left:12px;color:#555;font-style:italic}
h1,h2,h3{color:#2F5496}
ins.tc-ins{background:#e7f7e7;color:#14652f;text-decoration:underline}
del.tc-del{background:#fdeaea;color:#b02a2a;text-decoration:line-through}
span.comment-ref{background:#fff3bf;border-bottom:2px solid #f4a806}
.page-break{page-break-after:always;border:none}
</style></head><body>${html}</body></html>`;
}
