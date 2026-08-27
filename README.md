# Online Word-Compatible Editor

A browser-based, Word-compatible rich-text editor. The client is **zero
dependencies** — no npm packages, no bundler — vanilla ES modules, the
browser's native `CompressionStream`/`DecompressionStream` for .docx ZIP
handling, and hand-written OOXML (WordprocessingML) mapping. The Node server
reuses that exact client-side parser for server-side DOCX↔HTML conversion via
a jsdom DOM shim. The server keeps editor working data in `DATA_DIR`; LegalAI
remains the system of record for formally committed business documents.

Demo: https://doc.mochi-flow.com


## Quick start

```bash
bash run.sh                 # after npm ci; http://localhost:3001
# or
npm ci && npm start
# env overrides:
PORT=4000 HOST=0.0.0.0 DATA_DIR=/var/word-editor node server.js
```

Requires Node.js 22. Full env var reference is in
[Server configuration](#server-configuration) below.

### Why vanilla JavaScript

The editor uses browser-native ES modules because its core is DOM-intensive:
selection/range handling, `contenteditable`, clipboard events, print layout,
WebSocket, and OOXML import/export. Avoiding a framework keeps the SDK payload
small, removes a build step, and prevents a virtual DOM from competing with the
browser's live editable DOM. Vue remains suitable for a surrounding business
application, but would add little value inside this editor core unless the UI
is later redesigned around many state-driven components.

### Docker

```bash
docker build -t word-editor .
docker run -d --name word-editor -p 3001:3001 -v word-editor-data:/app/data word-editor
# or: docker compose up -d --build
```

## Features

**Documents & formats**
- `.docx` open + save with real OOXML round-trip: paragraphs, runs, headings,
  alignment, indentation, line spacing, **native list numbering** (numbering.xml,
  nested, bullet/decimal/letter/roman levels), **tables** (merged cells via
  gridSpan/vMerge, shading, widths), **inline images** (media parts + drawingml),
  **hyperlinks**, page size/orientation/margins (sectPr), document properties (core.xml)
- Exported packages are valid OOXML (validated against python-docx / strict XML parsing)
- Import also resolves *style-based* numbering (Word's `List Bullet` / `List Number`)
- Open `.txt` and `.html`; export `.docx`, `.html`, `.txt`, and PDF via the print
  pipeline (Ctrl+P → Save as PDF, honors page setup via `@page`)
- **Open & view `.pdf` files directly** — read-only viewer with zoom (Ctrl/⌘+scroll),
  fit-width and fit-screen, page navigation, download original, and print. pdf.js
  (Mozilla) is lazy-loaded from CDN so it only adds weight when actually opening a PDF.
- **Annotate & edit PDFs** — add comments (sticky notes), place wet stamps
  (upload any PNG/JPG image), edit page text in place, and apply **real digital
  signatures** (ECDSA-P-256-SHA-256 generated with WebCrypto and stored in
  IndexedDB; verifiable offline via the embedded public key). Right-click for
  the context menu. Save everything as a new PDF (via pdf-lib) — signed files
  carry their signature/public-key metadata as a `signature.json` file
  attachment embedded inside the PDF itself, not a separate sidecar.

**Editing**
- Bold/italic/underline/strikethrough, sub/superscript, font family/size (pt),
  text color, highlight palette
- Paragraph styles (Normal, Heading 1–6, Quote, Code block), alignment,
  indent/outdent, line spacing, bullet & numbered lists (nested)
- Format painter, clear formatting
- Find & replace: match case, regex, highlight-all, replace one/all
- Tables: insert dialog (header row option) + contextual table toolbar
  (insert/delete row/column, merge right/down, split, shading, delete table);
  Tab/Shift-Tab cell navigation
- Images (file picker, auto-scaled to printable width), links (Ctrl+K),
  horizontal rules, page breaks, symbol picker
- Page setup dialog: Letter/A4/Legal/A3, portrait/landscape, margins — reflected
  in the on-screen page, the printed PDF, and the saved .docx
- Undo/redo, spellcheck toggle (browser native), zoom, live word/character count
- Paste sanitization (allowlist-based, strips scripts/event handlers/dangerous URLs);
  loaded documents are sanitized before rendering (XSS defense)

**Collaboration & persistence**
- Autosave (debounced) with **optimistic concurrency**: each save carries the base
  revision; the server returns 409 on conflicting writes
- Real-time presence + live document sync over WebSocket: colored user chips;
  clean followers apply remote edits automatically, dirty editors get a conflict
  banner (*Load theirs / Keep mine*) with author attribution
- Version history: automatic server-side snapshots (capped, min 90s apart),
  browse + one-click restore (pre-restore state is snapshotted too)
- Library panel: open, delete; document rename via the title field

**Embedding & JS SDK**
- `public/js/sdk.js` — drop-in script for any host page:

```html
<script src="http://your-host:3001/js/sdk.js"></script>
<script>
  const ed = DocEditor.init({
    container: "#holder",
    docId: "…",              // optional
    mode: "edit",            // "edit" | "view"
    toolbar: true, statusbar: true,
    user: "Alice",           // presence name
    onReady(i) {}, onDocument(i) {}, onChange(i) {}, onSave(i) {}, onPresence(p) {}, onError(e) {},
  });
  await ed.getContent(); await ed.setContent(html);
  await ed.insertText(t); await ed.insertHtml(h); await ed.getText();
  await ed.getMeta(); await ed.setTitle(t); await ed.save();
  await ed.find(q, {matchCase, regex}); await ed.replaceAll(q, r, {});
  await ed.setMode("view"); await ed.loadDocument(id); ed.destroy();
</script>
```

- Live demo: open `/embed-example.html`
- Full-screen persistent demo: open `/fullscreen-test.html` (the last opened document is restored after refresh; `?doc=<id>` selects the initial document)
- Direct iframe embedding via URL flags: `/?embed=1&doc=<id>&mode=view&toolbar=0&statusbar=0&user=Bob`

**Server**
- REST: `GET/POST /api/documents`, `GET/PUT/DELETE /api/documents/:id`,
  `GET/PUT /api/documents/:id/docx`, `POST /api/documents/import` (parses the
  uploaded .docx into real HTML state server-side — see below),
  `GET /api/documents/:id/versions[/:n]`, `POST /api/documents/:id/restore`,
  `GET /api/health`
- WebSocket `/ws`: process-local rooms per document, presence and update/cursor relay
- LegalAI session bootstrap validates the business token and internally issues
  a short-lived token scoped to one tenant/contract/document — see
  [server/scopedAuth.js](server/scopedAuth.js)
- Legacy `.doc`/`.dot` import: converted to .docx via LibreOffice headless
  before parsing (needs the `soffice` binary — see the Dockerfile, or set
  `SOFFICE_PATH`); without it, `.doc` import fails with a clear 501 instead of
  a crash — see [server/docConvert.js](server/docConvert.js)
- Hardening: document-id validation (no path traversal), static-path containment,
  64 MB body cap, security headers, revision-checked writes

### Server configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3001` / `127.0.0.1` | listen address |
| `DATA_DIR` | `./data` | local working directory for drafts, versions, and generated DOCX files |
| `TOKEN_SECRET` | required for LegalAI | HMAC signing key for the short-lived document token issued by the LegalAI session endpoint |
| `SOFFICE_PATH` | `soffice` (PATH lookup) | path to the LibreOffice binary used for legacy `.doc`/`.dot` conversion |
| `LEGALAI_BASE_URL` | unset | LegalAI backend base URL, for example `https://legalai.example.com/legalai` |
| `LEGALAI_CONTENT_PATH` | `/zOffice/{docId}/content` | existing FileZ-compatible download/save endpoint used by word-editor |
| `LEGALAI_TOKEN_HEADER` | `token` | header used when forwarding the LegalAI business token |
| `LEGALAI_REQUEST_TIMEOUT_MS` | `30000` | timeout for LegalAI download/save calls |
| `LEGALAI_AUTO_COMMIT_ENABLED` | `false` | periodically publish the latest DOCX to LegalAI; internal draft autosave is unaffected |
| `LEGALAI_AUTO_COMMIT_INTERVAL_MS` | `300000` | periodic LegalAI publication interval; minimum 60 seconds |
| `VERSION_HISTORY_ENABLED` | `true` | word-editor internal snapshots; set `false` for the current LegalAI integration |

### LegalAI business-document integration

The LegalAI host initializes the SDK with its stable contract id and current
business token:

```js
const editor = DocEditor.init({
  container: "#editor",
  baseUrl: "https://legaloffice.example.com",
  docId: contractId,
  businessToken: legalAiToken,
  documentTitle: contractName,
  fileType: "docx",
  tenantId,
  history: false,
});
```

The iframe exchanges that business token for a short-lived word-editor token
only after the word-editor server successfully downloads
`GET {LEGALAI_BASE_URL}/zOffice/{docId}/content`. Draft autosaves update only
word-editor's local working directory. `Ctrl+S`, the File > Save action, the SDK
`save()`/`close()` commands, and the best-effort browser `pagehide` hook call
`POST /api/documents/{docId}/commit`; word-editor then uploads the generated
DOCX to the same FileZ-compatible LegalAI content endpoint. The business token
is retained only in memory for the active process and is never written to the
document metadata or storage objects.

## Architecture

```
server.js              HTTP + WebSocket server, storage/versions/LegalAI sessions
server/docxNode.mjs     jsdom DOM shim so the client's own docx.js can run
                       server-side unmodified (DOCX<->HTML conversion)
server/storage.js       local-directory working storage
server/scopedAuth.js    short-lived, document-scoped bearer tokens (HMAC)
server/docConvert.js    legacy .doc/.dot -> .docx via LibreOffice headless
public/js/docx.js      ZIP (native streams) + CRC32 + OOXML <-> HTML mapping
public/js/editor.js    toolbar, dialogs, find/replace, table ops, sanitizer
public/js/store.js     REST client, Autosaver (409-aware), SyncClient (WS)
public/js/main.js      app wiring, presence, conflicts, versions, postMessage API
public/js/sdk.js       embeddable host-page SDK (iframe + promise bridge)
public/embed-example.html   SDK demo
```

Storage files under `DATA_DIR`: `<id>.json` (state + pageSetup + rev + tenantId/contractId),
`<id>.source.docx` (immutable imported OOXML source), `<id>.docx` (current merged
artifact regenerated from HTML while retaining preserved OOXML objects),
`<id>.versions.json` (history).

## Requirements coverage — honest status

| Area | Status |
|---|---|
| .docx read/write | ✅ solid subset (see above); complex Word features degrade gracefully |
| .doc, .odt, .rtf, .dotx | ❌ not supported (see *Production notes*) |
| PDF/HTML/TXT export | ✅ (PDF via browser print) · EPUB ❌ |
| Text formatting, styles, lists | ✅ |
| Find & replace (regex) | ✅ · formatting-aware search ❌ |
| Spellcheck | ✅ browser-native · grammar/autocorrect ❌ |
| Page setup, page breaks | ✅ · columns, headers/footers, footnotes, TOC, watermarks ❌ |
| Tables (merge/split/shading) | ✅ · table formulas ❌ |
| Images | ✅ inline · crop/wrap/anchored positioning ❌ |
| Embedded objects, native shapes/WordArt, SmartArt, charts, equations | ⚠️ read-only preview/placeholder; original OOXML retained · native editing ❌ |
| Hyperlinks, symbols | ✅ · bookmarks/cross-references ❌ |
| Presence + live sync | ✅ (rev-based last-writer-wins + conflict UI) |
| Character-level co-editing (OT/CRDT) | ❌ — see below |
| Track changes, comments | ❌ (tracked inserts are imported as plain text) |
| Version history & restore | ✅ |
| Embedding, JS SDK, events | ✅ |
| Theming/multi-language UI | ❌ (CSS variables make theming straightforward) |
| Auth, autosave, locking | ✅ LegalAI session token, autosave, rev-guard |
| Docker deployment | ✅ |

### Production notes — read this

This is a genuinely usable, self-hosted editor for the feature set listed above,
and every listed feature is implemented and tested. But two classes of
requirements are **not honestly achievable in a from-scratch stack** of this size,
regardless of effort:

1. **Bit-perfect MS Word fidelity across arbitrary documents** (embedded objects,
   SmartArt, equations, macros, .doc/.odt/.rtf). Word's format surface is
   enormous; even mature open-source suites approximate it. If you need
   open-anything/round-trip-anything guarantees, put this UI aside and deploy
   **OnlyOffice Document Server** or **Collabora Online** (both open-source,
   Docker-ready) behind your app — that is what commercial products do.
2. **Character-level concurrent co-editing.** This project ships revision-guarded
   sync with presence and conflict resolution, which is safe and predictable.
   True Google-Docs-style merging requires OT/CRDT (e.g. Yjs) and a matching
   document model — a rewrite of the editing core, not an increment.

Everything else in the table above is a reasonable incremental addition to this
codebase (headers/footers, footnotes, TOC generation, comments are the natural
next slice).

## Keyboard shortcuts

Ctrl/⌘+B/I/U formatting · Ctrl/⌘+K link · Ctrl/⌘+F find & replace ·
Ctrl/⌘+S save · Ctrl/⌘+Shift+S export .docx · Ctrl/⌘+P print/PDF ·
Ctrl/⌘+Alt+0…6 paragraph styles · Ctrl/⌘+Z / Shift+Z undo/redo ·
Tab/Shift+Tab indent or table-cell navigation

## Troubleshooting

**"EPERM: process.cwd failed" on launch** — macOS TCC: launching Node with a
*relative* script path from a protected folder (~/Documents, ~/Downloads) fails.
`run.sh` handles this (cd $HOME + absolute path). For file-write issues set
`DATA_DIR` outside protected folders, or use Docker.
