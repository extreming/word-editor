# doc-editor

doc-editor is a browser-based document editor with DOCX import/export, comments,
tracked text changes, page layout, PDF tools, and an embedding SDK. The core
Word-editing client uses **zero npm dependencies**: vanilla ES modules with no
bundler, the
browser's native `CompressionStream`/`DecompressionStream` for .docx ZIP
handling, and hand-written OOXML (WordprocessingML) mapping. The Node server
reuses that exact client-side parser for server-side DOCX↔HTML conversion via
a jsdom DOM shim. The server keeps editor working data in `DATA_DIR`; LegalAI
remains the system of record for formally committed business documents.


[Product manual / 产品手册](docs/doc-editor产品手册.md) ·
[SDK reference / SDK 方法](docs/JS%20SDK集成方法说明.md) ·
[Integration guide](docs/doc-editor集成指南.md) ·
[Deployment guide](docs/doc-editor-deployment-guide.md)

The Git repository is named `docflow`; the product, npm package and deployment
identifiers use `doc-editor`. SDK integrations use `DocEditor.init()` and
`DocEditorRestClient`. The interim `Docflow` / `DocflowRestClient` globals remain
compatibility aliases. Browser preferences migrate to `doc-editor:` without
deleting previous values; the existing PDF signing-key database is preserved.

When updating an existing deployment, preserve its actual data directory using
`HOST_DATA_DIR`, and use `doc-editor` for Compose service commands. The default
business content path is `/doc-editor/{docId}/content`; keep any custom backend
path explicitly configured in `BUSINESS_DOCUMENT_CONTENT_PATH`. No business
backend, Git remote or physical workspace directory is renamed by this change.

[Demo site](https://doc.mochi-flow.com) — a deployed instance may differ from this checkout.


## Quick start

```bash
bash run.sh                 # after npm ci; http://localhost:3001
# or
npm ci && npm start
# env overrides:
PORT=4000 HOST=0.0.0.0 DATA_DIR=/var/doc-editor node server.js
```

Requires Node.js 22. Full env var reference is in
[Server configuration](#server-configuration) below.

Open `/editor.html` for the standalone editor; `/` is the landing page and demo.
On PowerShell, run `npm ci` and `npm start` as separate commands. To override
the port, set `$env:PORT = "4000"` before starting the server.

The server depends on `jsdom`; it is not dependency-free. PDF viewing and editing
load pdf.js and pdf-lib from external CDNs on demand. Browser JavaScript, native
compression streams, and network access to those PDF resources are required.

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
docker build -t doc-editor .
docker run -d --name doc-editor -p 3001:3001 -v doc-editor-data:/app/data doc-editor
# or: docker compose up -d --build
```

Before using the checked-in Compose file, configure its host data and CA-bundle
mounts, business API address, and signing secret for the target environment.
It binds host port 3001 to loopback, disables internal version history, and
enables startup draft cleanup. A data volume alone does not disable that cleanup.

The current Dockerfile **does not install LibreOffice**. Setting `SOFFICE_PATH`
does not install it either; legacy `.doc`/`.dot` conversion requires a separately
installed `soffice` executable or a customized image. Native `.docx` handling
does not use LibreOffice.

## Features

**Documents & formats**

- `.docx` open + save with real OOXML round-trip: paragraphs, runs, headings,
  alignment, indentation, line spacing, **native list numbering** (numbering.xml,
  nested, bullet/decimal/letter/roman levels), **tables** (merged cells via
  gridSpan/vMerge, shading, widths), **inline images** (media parts + drawingml),
  **hyperlinks**, page size/orientation/margins (sectPr), document properties (core.xml)
- Complex imported objects use read-only previews/placeholders with original
  OOXML retained through the DOCX source-package merge path. XML/package validity
  does not guarantee identical Word rendering; see [Compatibility](#compatibility).
- Import also resolves *style-based* numbering (Word's `List Bullet` / `List Number`)
- Open `.txt` and `.html`; export `.docx`, `.html`, `.txt`, and PDF via the print
  pipeline (Ctrl+P → Save as PDF, honors page setup via `@page`)
- **Open & view `.pdf` files directly** — dedicated viewer with zoom (Ctrl/⌘+scroll),
  fit-width and fit-screen, page navigation, download original, and print. pdf.js
  (Mozilla) is lazy-loaded from CDN so it only adds weight when actually opening a PDF.
- **Annotate & edit PDFs** — comments, stickers, uploaded image stamps,
  signature placement, and limited inline text editing. Use the PDF toolbar's
  **Save as new PDF** button to download changes through pdf-lib. This path
  does not use document draft autosave, version history, or LegalAI write-back.
- PDF text changes cover the original text with white rectangles and redraw it
  using built-in Helvetica fonts. This is not redaction or OCR; CJK text,
  original fonts, and complex layouts are not fully supported.
- PDF signature placement uses a browser-generated ECDSA-P-256 key stored in
  IndexedDB and attaches custom `signature.json` metadata. It does not implement
  standard certificate-based PDF signatures or guarantee verification by
  external PDF readers. No general offline-verification guarantee is made.

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
  horizontal rules, page breaks, blank pages, symbol picker; image resize,
  alignment/float controls and draggable CSS shapes
- Page setup dialog: Letter/A4/Legal/A3, portrait/landscape, margins — reflected
  in the on-screen page, the printed PDF, and the saved .docx
- Headers, footers, and page-number fields, including left/center/right placement
  and numeric, roman, alphabetic, or page/total-page formats
- WordArt-style text and shape insertion in the browser; CSS visual effects do
  not have full native Word object export mappings
- Undo/redo, spellcheck toggle (browser native), zoom, live word/character count
- Chinese/English UI, initial SDK locale, and user language switching; some PDF
  controls remain English. Switching language reloads the page, so save first.
- Paste sanitization (allowlist-based, strips scripts/event handlers/dangerous URLs);
  loaded documents are sanitized before rendering (XSS defense)

**Comments & review**

- Anchor a comment to selected text, reply, resolve/reopen, and delete; deletion
  emits the SDK `onCommentDelete({ id })` event
- Track text insertions/deletions, review individual changes, or accept/reject all;
  tracked changes and comment anchors have DOCX import/export implementations
- Replies persist in editor working data but are flattened into comment text on
  DOCX export; reply threads and resolved state do not round-trip completely
- Tracking does not cover every Word revision type, such as all formatting or
  object changes; switching tracking off leaves existing revisions for review

**Collaboration & persistence**

- Autosave (1.2-second debounce) with **optimistic concurrency**: each editor save carries the base
  revision; the server returns 409 on conflicting writes
- Real-time presence + live document sync over WebSocket: colored user chips;
  clean followers apply remote edits automatically, dirty editors get a conflict
  banner (*Load theirs / Keep mine*) with author attribution
- Version history: automatic server-side snapshots (capped, min 90s apart),
  browse + restore (pre-restore state is snapshotted too), at most 10 snapshots
  from the last three days; enabled by the server default but disabled in Compose
- Library panel: open, delete; document rename via the title field
- This is revision-based document synchronization, not character-level merging.
  **Load theirs** discards local pending edits; **Keep mine** can overwrite the
  remote content. Working data is subject to [cleanup](#working-data-lifecycle).

## Embedding & JS SDK

Load `public/js/sdk.js` and give its container an explicit height. Wait for
`onReady` before invoking document commands:

```html
<div id="holder" style="height: 80vh"></div>
<script src="/js/sdk.js"></script>
<script>
  // Same-origin example. For another origin, load its sdk.js and set baseUrl.
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const editor = DocEditor.init({
    container: "#holder",
    // docId: "existing-document-id", // omit to open a new document
    mode: "edit",            // "edit" | "view"
    toolbar: true, statusbar: true,
    locale: "zh",            // optional: "zh" | "en"
    user: "Alice",           // presence name
    onReady: resolveReady,
    onSave(info) { console.log("save result", info); },
    onCommentDelete(info) { console.log("deleted comment", info.id); },
    onError(error) { console.error(error); },
  });

  async function inspectDocument() {
    await ready;
    console.log(await editor.getMeta());
    console.log(await editor.getText());
    const { matches } = await editor.find("contract", { matchCase: false });
    if (matches > 0) await editor.highlightSelection();
    // Later: await editor.clearHighlight();
  }
  inspectDocument().catch(console.error);

  // Call from the host's close action; only leave after successful submission.
  async function closeEditor() {
    await ready;
    await editor.close();
    editor.destroy();
  }
</script>
```

The SDK also exposes content insertion/replacement, formatting, tables/images,
page setup, headers/footers, comments/review, undo/redo, document library,
history, and export methods. See [SDK 方法](docs/JS%20SDK集成方法说明.md) for signatures.
`close()` submits the document but does not remove the iframe; `destroy()` removes
the instance but does not save it. `mode: "view"` disables direct body editing
and hides the toolbar; it is not a server-side authorization boundary.

`locale` accepts only `zh` or `en`. Initial precedence is URL/SDK locale, saved
browser preference, then browser language. Users can switch language afterward.
Events include `onReady`, `onDocument`, `onChange`, `onSave`, `onCommentDelete`,
`onPresence`, and `onError`. Comment deletion signals a local deletion and save
scheduling, not completed business-system persistence.

`highlightSelection()` operates on the current editor selection (including one created by `find()`), returns `{ok:true}`, and replaces the previous SDK highlight. `clearHighlight()` is idempotent and removes only that temporary SDK highlight. Neither method modifies document HTML, saved/exported content, or undo history. `highlightSelection()` rejects when there is no non-empty text selection or the browser lacks the CSS Custom Highlight API.

- Live demo: open `/embed-example.html`
- Full-screen persistent demo: open `/fullscreen-test.html` (attempts to reopen the last document if its working data still exists; `?doc=<id>` selects the initial document)
- Direct iframe embedding via URL flags: `/?embed=1&doc=<id>&mode=view&toolbar=0&statusbar=0&locale=zh&user=Bob`
- Deployment version: open `/version` to display the `version` from `package.json`

## Server API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Process health |
| GET / POST | `/api/documents` | List / create working documents |
| POST | `/api/documents/import` | Import base64 file bytes in `{ name, data }`, parsing DOCX into HTML state |
| GET / PUT / DELETE | `/api/documents/:id` | Read / update / delete a working document |
| GET / PUT | `/api/documents/:id/docx` | Read / upload DOCX bytes (PUT uses JSON/base64) |
| GET / PUT | `/api/documents/:id/content` | Read content / replace HTML |
| GET | `/api/documents/:id/text` | Read plain text |
| POST | `/api/documents/:id/insert-html`, `/api/documents/:id/insert-text` | Append HTML or text to stored content |
| PUT | `/api/documents/:id/title` | Rename |
| GET / PUT | `/api/documents/:id/meta` | Read / update metadata |
| GET | `/api/documents/:id/export?fmt=docx\|html\|txt` | Download an export; PDF export uses browser print |
| GET / POST | `/api/documents/:id/comments` | List / add comments; REST add does not anchor a browser selection |
| GET / PUT | `/api/documents/:id/track-changes` | Read / set the tracking flag |
| GET / PUT | `/api/documents/:id/page-setup` | Read / update page settings |
| GET | `/api/documents/:id/versions`, `/api/documents/:id/versions/:n` | List / read snapshots |
| POST | `/api/documents/:id/restore` | Restore a snapshot |
| POST | `/api/format` | Apply a supported formatting transform to an HTML fragment |
| POST | `/api/integrations/legalai/session` | Validate business access and create a scoped editor session |
| POST | `/api/documents/:id/commit` | Generate and publish DOCX to the business system |

See [REST client](public/js/api-client.js), [server routes](server.js), and the
`/api-docs.html` page for request details. REST append operations act on stored
content, whereas SDK insertion acts on the editor's current selection/caret.
The editor sends `baseRev` on its normal document updates; do not assume every
REST helper endpoint has the same concurrency guard or browser review behavior.

- WebSocket `/ws`: process-local rooms per document, presence and update/cursor relay
- LegalAI session bootstrap validates the business token and internally issues
  a short-lived token scoped to one tenant/contract/document — see
  [server/scopedAuth.js](server/scopedAuth.js)
- Legacy `.doc`/`.dot` import: converted to .docx via LibreOffice headless
  before parsing when `soffice` is installed; otherwise import returns 501.
  The standard file picker currently lists only `.docx`, `.txt`, `.htm`, `.html`,
  and `.pdf`; use the server integration path for legacy files or convert them
  before opening — see [server/docConvert.js](server/docConvert.js)
- Hardening: document-id validation (no path traversal), static-path containment,
  64 MB request-body cap, security headers, revision-checked editor writes.
  Base64 encoding adds overhead, so the cap is not a guaranteed 64 MB file limit.

### Server configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3001` / `127.0.0.1` | listen address |
| `DATA_DIR` | `./data` | local working directory for drafts, versions, and generated DOCX files |
| `TOKEN_SECRET` | required for LegalAI | HMAC signing key for the short-lived document token issued by the LegalAI session endpoint |
| `SOFFICE_PATH` | `soffice` (PATH lookup) | path to the LibreOffice binary used for legacy `.doc`/`.dot` conversion |
| `BUSINESS_API_BASE_URL` | unset | host business-system API base URL |
| `BUSINESS_DOCUMENT_CONTENT_PATH` | `/doc-editor/{docId}/content` | host endpoint used to download and publish a business document |
| `BUSINESS_TOKEN_HEADER` | `token` | header used when forwarding the host business token |
| `BUSINESS_REQUEST_TIMEOUT_MS` | `30000` | timeout for host business-system requests; minimum 1000 ms |
| `BUSINESS_AUTO_COMMIT_ENABLED` | `false` | periodically publish the latest DOCX to the host system; internal draft autosave is unaffected |
| `BUSINESS_AUTO_COMMIT_INTERVAL_MS` | `300000` | periodic host-system publication interval; minimum 60 seconds |
| `VERSION_HISTORY_ENABLED` | `true` | doc-editor internal snapshots; checked-in Compose sets `false` |
| `DATA_RETENTION_HOURS` | `24` | inactivity period before committed or unconfirmed LegalAI working files are removed |
| `DATA_CLEANUP_INTERVAL_MS` | `86400000` | periodic lifecycle sweep interval; minimum 60 seconds |
| `STARTUP_DRAFT_PURGE_ENABLED` | `true` | on startup remove history and scrub draft payloads while retaining lifecycle metadata |
| `DISK_CHECK_INTERVAL_MS` | `300000` | local data filesystem usage check interval; minimum 60 seconds |
| `DISK_WARNING_PERCENT` / `DISK_CRITICAL_PERCENT` | `70` / `85` | warning and critical disk-usage thresholds |
| `NODE_EXTRA_CA_CERTS` | unset | Node runtime CA bundle for outbound TLS; Compose mounts the host bundle here |

The previous `LEGALAI_*` environment-variable names remain supported as deprecated aliases. When both forms are set, the corresponding `BUSINESS_*` value takes precedence.

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
  locale: "zh",
});
```

The iframe exchanges that business token for a short-lived doc-editor token
only after the doc-editor server successfully downloads
`GET {BUSINESS_API_BASE_URL}/doc-editor/{docId}/content`. Draft autosaves update only
doc-editor's local working directory. `Ctrl+S`, the File > Save action, the SDK
`save()`/`close()` commands, and the best-effort browser `pagehide` hook call
`POST /api/documents/{docId}/commit`; doc-editor then uploads the generated
DOCX to the same FileZ-compatible LegalAI content endpoint. The business token
is retained only in memory for the active process and is never written to the
document metadata or storage objects.

Manual/SDK save first waits for the draft flush, then submits DOCX. The browser
`pagehide` hook cannot wait reliably and only makes a best-effort request; it is
not equivalent to awaiting `close()`. The host should await `close()` before
destroying the iframe or navigating away.

Standalone saves skip business publication with `skipped: "not-legalai"`.
An `onSave` callback or the status label alone is not proof of business write-back:
inspect the result. Downloading a file also does not commit it to LegalAI.
Timed business publication is disabled by default and is separate from autosave.

## Architecture

```
server.js              HTTP + WebSocket server, storage/versions/LegalAI sessions
server/docxNode.mjs     jsdom DOM shim so the client's own docx.js can run
                       server-side unmodified (DOCX<->HTML conversion)
server/storage.js       local-directory working storage
server/scopedAuth.js    short-lived, document-scoped bearer tokens (HMAC)
server/docConvert.js    legacy .doc/.dot -> .docx via LibreOffice headless
server/dataLifecycle.js cleanup, version retention, disk usage audit
public/js/docx.js      ZIP (native streams) + CRC32 + OOXML <-> HTML mapping
public/js/editor.js    toolbar, dialogs, find/replace, table ops, sanitizer
public/js/history.js   local undo/redo
public/js/i18n.js      Chinese/English strings and locale selection
public/js/pdf-view.js  PDF viewing, annotations, limited editing and export
public/js/store.js     REST client, Autosaver (409-aware), SyncClient (WS)
public/js/main.js      app wiring, presence, conflicts, versions, postMessage API
public/js/sdk.js       embeddable host-page SDK (iframe + promise bridge)
public/js/api-client.js REST client helpers
public/embed-example.html   SDK demo
```

### Working data lifecycle

Storage files under `DATA_DIR`: `<id>.json` (state + pageSetup + rev + tenantId/contractId),
`<id>.source.docx` (immutable imported OOXML source), `<id>.docx` (current merged
artifact regenerated from HTML while retaining preserved OOXML objects),
`<id>.versions.json` (history), and `cleanup-audit.log` (JSON-lines lifecycle
audit records). History is capped at 10 snapshots and three days.

For LegalAI documents, a successful write-back persists `lastCommittedRev` in
the metadata. A successful SDK `close()` followed by the last WebSocket leaving
the document room removes all four working files immediately. Otherwise a daily
sweep removes inactive committed documents after 24 hours and retains an
unconfirmed draft for 24 hours before removing it. Browser `pagehide` is only a
best-effort save signal and does not trigger immediate cleanup. With the default
`STARTUP_DRAFT_PURGE_ENABLED=true`, process start removes draft state, comments,
page settings, tracking flags and history for both standalone and business
documents; lifecycle metadata and DOCX artifacts remain. Business metadata is
retained so remaining DOCX artifacts can still be audited and reclaimed by the
inactive-document sweep. Disk usage is checked every five minutes, with warning and critical
audit events at 70% and 85%.

The daily inactive-document sweep applies to LegalAI working documents and skips
active rooms. The 24-hour threshold is evaluated at sweep time, not an exact
deletion deadline. Export standalone documents or explicitly configure draft
retention for your use case; the default working directory is not an archive.

## Compatibility

| Area | Status |
|---|---|
| .docx read/write | ✅ solid subset (see above); complex Word features degrade gracefully |
| .doc / .dot | Conditional server-side conversion; requires separately installed LibreOffice |
| .odt, .rtf, .dotx, macro documents | No supported general import/edit contract |
| PDF/HTML/TXT export | ✅ (PDF via browser print) · EPUB ❌ |
| Text formatting, styles, lists | ✅ |
| Find & replace (regex) | ✅ · formatting-aware search ❌ |
| Spellcheck | ✅ browser-native · grammar/autocorrect ❌ |
| Page setup, page breaks, headers/footers, page numbers | ✅ common cases; full section/first-page/odd-even rules not covered |
| Columns, footnotes, TOC, watermarks | No native editing workflow |
| Tables (merge/split/shading) | ✅ · table formulas ❌ |
| Images | Inline import/export; browser resize/alignment/float controls; full Word positioning/cropping fidelity not guaranteed |
| New browser shapes / WordArt-style text | Browser editing; CSS shapes and effects do not fully export as native Word objects |
| Embedded objects, native shapes/WordArt, SmartArt, charts, equations | ⚠️ read-only preview/placeholder; original OOXML retained · native editing ❌ |
| Hyperlinks, symbols | ✅ · bookmarks/cross-references ❌ |
| Presence + live sync | ✅ revision-checked editor saves with explicit conflict handling |
| Character-level co-editing (OT/CRDT) | ❌ |
| Track changes, comments | ✅ text insert/delete review and anchored comments; partial Word round-trip |
| Version history & restore | ✅ when enabled; bounded retention, disabled in checked-in Compose |
| Embedding, JS SDK, events | ✅ |
| Multi-language UI | ✅ Chinese/English; PDF controls partly English |
| Theming | CSS variables; no dedicated theme settings UI |
| Auth and autosave | LegalAI scoped session token, autosave, revision guard; no exclusive editing lock |
| Docker deployment | ✅ |

Imported OOXML objects are preserved where supported, but that does not make
their previews editable or guarantee pixel-identical Word output. Browser fonts,
pagination, floating layouts and unsupported structures can differ. Keep the
original file and check exported DOCX in the intended Word application for
complex documents. Replacing the full HTML or removing object placeholders can
discard information needed for preservation.

## Development checks

```bash
npm test
node --check server.js
git diff --check
```

The current test files cover OOXML namespace preservation/repair, selected table
and floating-object cases, sanitization, and data lifecycle rules. These checks
do not establish complete browser, PDF, SDK, Word-compatibility, or deployed
business-save coverage. Verify those paths separately for the target deployment.

## Keyboard shortcuts

Ctrl/⌘+B/I/U formatting · Ctrl/⌘+K link · Ctrl/⌘+F find & replace ·
Ctrl/⌘+S save · Ctrl/⌘+Shift+S export .docx · Ctrl/⌘+P print/PDF ·
Ctrl/⌘+Alt+0…6 paragraph styles · Ctrl/⌘+Z / Shift+Z undo/redo ·
Ctrl/⌘+Y redo · Ctrl/⌘+Alt+M add comment · Ctrl/⌘+Shift+E toggle tracking ·
Tab/Shift+Tab indent or table-cell navigation

## Troubleshooting

- **Saved in the editor but unchanged in LegalAI:** draft autosave and export
  are separate from formal publication. Trigger Save, check the returned result,
  and inspect business API/session errors.
- **Draft missing after restart:** startup purge is enabled by default. See
  [Working data lifecycle](#working-data-lifecycle).
- **No history:** Compose disables server snapshots; `history: false` also
  hides the UI. Enabled automatic snapshots are at least 90 seconds apart.
- **Legacy DOC import returns 501:** install/configure LibreOffice; the current
  Docker image does not bundle it. Alternatively supply DOCX directly.
- **PDF fails to load or save:** check CDN access and browser capabilities;
  edited CJK text can fail with the current PDF output fonts. Use the PDF-specific
  save button and inspect the downloaded file before closing the viewer.
- **Business HTTPS request fails:** configure the CA bundle used by Node for
  outbound requests. The browser-facing TLS certificate does not establish
  trust for requests made by the container.

**"EPERM: process.cwd failed" on launch** — macOS TCC: launching Node with a
*relative* script path from a protected folder (~/Documents, ~/Downloads) fails.
`run.sh` handles this (cd $HOME + absolute path). For file-write issues set
`DATA_DIR` outside protected folders, or use Docker.
