# JS SDK集成方法说明

产品正式名称为 `doc-editor`，Git 仓库名称为 `docflow`。SDK 入口使用 `DocEditor.init()`，REST 客户端使用 `DocEditorRestClient`。此前临时使用的 `Docflow` / `DocflowRestClient` 保留为兼容别名，新代码和示例统一使用正式入口。

sdk集成命令导航：/api-docs.html#sdk

通过 `const ed = DocEditor.init(options)` 获取实例，以下方法均通过 `ed.方法名()` 调用。除 `destroy()` 外，实例方法都返回 Promise。

## 1. 初始化与生命周期

| 方法                      | 用途                                      |
| ------------------------- | ----------------------------------------- |
| `DocEditor.init(options)` | 创建 iframe 并返回编辑器实例              |
| `loadDocument(id)`        | 打开或切换文档                            |
| `setMode(mode)`           | 切换 `"edit"` 编辑 / `"view"` 查看模式    |
| `focus()`                 | 聚焦编辑区                                |
| `save()`                  | 正式保存；接入 LegalAI 时执行业务文档回写 |
| `close()`                 | 执行关闭前正式保存，**不会移除 iframe**   |
| `destroy()`               | 移除 iframe、清理监听，**不会自动保存**   |

options初始化参数如下：

| 参数            | 含义                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `container`     | **必填**。承载编辑器 iframe 的 DOM 元素，或可定位该元素的 CSS 选择器；找不到元素时 `DocEditor.init()` 会抛出错误。                         |
| `baseUrl`       | 编辑器服务的基础地址，例如 `"http://localhost:3001"`。不传时使用加载 `sdk.js` 的来源地址。                                                 |
| `docId`         | 要打开的已有文档 ID。不传或加载失败时，编辑器会尝试打开本地记录的最近文档，否则新建文档。                                                  |
| `mode`          | 初始模式：`"edit"` 为编辑模式，`"view"` 为只读查看模式；不传或传入其他值时为编辑模式。                                                     |
| `toolbar`       | 是否显示工具栏。默认显示；仅传入 `false` 时隐藏。                                                                                          |
| `statusbar`     | 是否显示底部状态栏。默认显示；仅传入 `false` 时隐藏。                                                                                      |
| `locale`        | 初始界面语言，仅支持 `"zh"` 或 `"en"`。不传时按用户上次选择或浏览器语言自动确定，其他值会抛出错误。                                        |
| `user`          | 当前协作用户的显示名称，用于在线协作状态；编辑器会截断为最多 40 个字符。不传时使用本地保存的名称，首次使用时自动生成访客名称。             |
| `documentTitle` | 通过 LegalAI 会话打开文档时使用的业务文档标题；同时作为编辑器 URL 中的 `title` 参数。                                                      |
| `fileType`      | 通过 LegalAI 会话打开文档时使用的业务文件类型，例如 `"docx"`；未传时该会话默认使用 `"docx"`。                                              |
| `tenantId`      | 通过 LegalAI 会话打开文档时传递的租户标识；可传数字或字符串。                                                                              |
| `history`       | 是否显示历史版本入口。默认显示；仅传入 `false` 时隐藏。                                                                                    |
| `businessToken` | 业务会话凭证，SDK 将其置于 iframe URL 片段而不是查询参数中，避免随页面请求、访问日志或 Referer 发送；与 `docId` 一起传入时会建立业务会话。 |

初始化示例

```javascript
// ─── bootstrap ───
const ed = DocEditor.init({
  container: "#editor-holder", // CSS selector or Element
  baseUrl: "http://localhost:3001",
  user: "Alice",
  onReady(info) {
    console.log("ready", info);
  },
  onDocument(info) {
    console.log("document", info);
  },
  onChange(info) {
    console.log("change", info);
  },
});

// ─── command methods return Promises; destroy() is synchronous ───
const meta = await ed.getMeta();
const html = (await ed.getContent()).html;
await ed.setContent("<p>Hello</p>");
await ed.bold();
await ed.justifyCenter();
await ed.insertImage("https://picsum.photos/360/200", {
  width: 360,
  height: 200,
});
await ed.exportDoc("docx");
await ed.setPageSetup({ size: "A4", margins: { top: 1, left: 1 } });
const docs = await ed.listDocuments();
await ed.newDocument("Memo");
await ed.addComment("Review this paragraph");
const { matches } = await ed.find("term", { matchCase: false, regex: false });
if (matches > 0) await ed.highlightSelection(); // temporary orange background / white text
await ed.clearHighlight(); // restore the selection's original styles
await ed.close(); // wait for save before removing the iframe
ed.destroy();
```

此外，还传入下文第10章中列出的事件回调。

## 2. 内容、选区与查找

| 方法                                      | 用途 / 返回值                                                 |
| ----------------------------------------- | ------------------------------------------------------------- |
| `getContent()`                            | 获取正文 HTML，返回 `{html}`                                  |
| `getText()`                               | 获取正文纯文本，返回 `{text}`                                 |
| `setContent(html)`                        | 替换整个正文内容                                              |
| `insertText(text)`                        | 在光标或选区位置插入纯文本                                    |
| `insertHtml(html)`                        | 在光标或选区位置插入 HTML                                     |
| `getSelectedText()`                       | 获取当前选区内容，返回 `{text, html}`                         |
| `getMeta()`                               | 获取文档 ID、标题、版本、字数、页面设置、修订状态、批注数量等 |
| `setTitle(title)`                         | 修改文档标题                                                  |
| `find(query, options)`                    | 查找、选中并滚动到首个匹配，不添加高亮，返回 `{matches}`      |
| `highlightSelection()`                    | 当前选区临时显示橘底白字，返回 `{ok:true}`                    |
| `clearHighlight()`                        | 清除 SDK 临时高亮、恢复原有样式，返回 `{ok:true}`             |
| `replaceAll(query, replacement, options)` | 全部替换，返回 `{replaced}`                                   |

`find`、`replaceAll` 的 `options` 支持 `{matchCase, regex}`。

```js
const { matches } = await ed.find("待定位的文本", { matchCase: false });
if (matches > 0) await ed.highlightSelection(); // 橘底 #ff9632、白字 #fff
await ed.clearHighlight(); // 保留选区和文本原有的颜色、底色、字体等样式
```

`highlightSelection()` 只作用于当前选区（也可以手动选择文本），不自动高亮全部匹配；再次调用会替换上一次 SDK 高亮。`clearHighlight()` 可重复调用，不清除文档自身的底色或查找面板的高亮。没有有效文本选区时，`highlightSelection()` 会拒绝 Promise。

## 3. 撤销与重做

| 方法        | 用途                                                       |
| ----------- | ---------------------------------------------------------- |
| `undo()`    | 撤销                                                       |
| `redo()`    | 重做                                                       |
| `canUndo()` | 同时返回 `{canUndo, canRedo}`，没有单独的 `canRedo()` 方法 |

## 4. 字体与段落格式

| 方法                            | 用途                                  |
| ------------------------------- | ------------------------------------- |
| `format(cmd, value)`            | 通用格式命令，内部调用 `execCommand`  |
| `bold()`                        | 加粗                                  |
| `italic()`                      | 斜体                                  |
| `underline()`                   | 下划线                                |
| `strikeThrough()`               | 删除线                                |
| `subscript()` / `superscript()` | 下标 / 上标                           |
| `fontName(font)`                | 设置字体                              |
| `fontSize(size)`                | 设置字号，使用 `execCommand` 的字号值 |
| `foreColor(color)`              | 设置文字颜色                          |
| `hiliteColor(color)`            | 设置高亮颜色                          |
| `formatBlock(tag)`              | 设置段落标签，例如 `"H1"`、`"P"`      |
| `justifyLeft()`                 | 左对齐                                |
| `justifyCenter()`               | 居中                                  |
| `justifyRight()`                | 右对齐                                |
| `justifyFull()`                 | 两端对齐                              |
| `insertOrderedList()`           | 有序列表                              |
| `insertUnorderedList()`         | 无序列表                              |
| `indent()` / `outdent()`        | 增加 / 减少缩进                       |

## 5. 插入元素

| 方法                        | 用途                                            |
| --------------------------- | ----------------------------------------------- |
| `insertImage(src, options)` | 插入图片，`options` 支持 `{alt, width, height}` |
| `insertLink(href, text)`    | 插入链接                                        |
| `insertTable(rows, cols)`   | 插入表格                                        |
| `insertSymbol(ch)`          | 插入符号                                        |
| `insertPageBreak()`         | 插入分页符                                      |
| `insertBlankPage()`         | 插入空白页                                      |
| `insertHr()`                | 插入水平分隔线                                  |

## 6. 页面、页眉页脚与缩放

| 方法                      | 用途                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `setHeader(text, align)`  | 设置页眉；空文本可删除                                      |
| `setFooter(text, align)`  | 设置页脚；空文本可删除                                      |
| `setPageNumbers(options)` | 设置页码，参数 `{enabled, format, place}`                   |
| `setPageSetup(options)`   | 设置纸张、方向、页边距，参数 `{size, orientation, margins}` |
| `getPageSetup()`          | 获取页面设置，返回 `{pageSetup}`                            |
| `setZoom(z)`              | 设置缩放比例，例如 `1.25` 表示 125%                         |
| `getZoom()`               | 获取缩放比例，返回 `{zoom}`                                 |

`align` 支持 `"left"`、`"center"`、`"right"`；`margins` 支持 `{top, bottom, left, right}`。

## 7. 文档库与历史版本

| 方法                    | 用途                                       |
| ----------------------- | ------------------------------------------ |
| `listDocuments()`       | 获取文档列表，返回 `{documents}`           |
| `newDocument(title)`    | 新建并打开文档                             |
| `deleteDocument(id)`    | 删除指定文档，**不允许删除当前打开的文档** |
| `listVersions()`        | 获取当前文档历史版本，返回 `{versions}`    |
| `restoreVersion(index)` | 按版本索引恢复当前文档                     |

## 8. 批注与修订

| 方法                       | 用途                                            |
| -------------------------- | ----------------------------------------------- |
| `addComment(text, author)` | 给当前选区添加批注，**必须有选区**，返回 `{id}` |
| `getComments()`            | 获取批注列表，返回 `{comments}`                 |
| `setTrackChanges(on)`      | 开启 / 关闭修订                                 |
| `getChanges()`             | 获取修订列表，返回 `{changes}`                  |
| `acceptAllChanges()`       | 接受全部修订                                    |
| `rejectAllChanges()`       | 拒绝全部修订                                    |

## 9. 导出与打印

| 方法             | 用途                                                     |
| ---------------- | -------------------------------------------------------- |
| `exportDoc(fmt)` | 导出 `"docx"`、`"html"`、`"txt"`；`"pdf"` 调用浏览器打印 |
| `previewPrint()` | 打开浏览器打印窗口                                       |

导出会触发浏览器下载或打印，**不会向调用方返回文件 Blob**。

## 10. 事件回调与属性

初始化时可传入以下回调，当前没有单独的 `on()` / `off()` 方法：

| 回调                      | 参数         | 触发时机                 |
| ------------------------- | ------------ | ------------------------ |
| `onReady(info)`           | 就绪信息     | 编辑器初始化就绪         |
| `onDocument(info)`        | 文档信息     | 文档打开或切换           |
| `onChange(info)`          | 变更信息     | 文档内容变化             |
| `onSave(info)`            | 保存结果     | 保存完成                 |
| `onCommentDelete({ id })` | `{id}`       | 用户确认并完成批注删除后 |
| `onPresence(info)`        | 在线用户信息 | 协作在线状态变化         |
| `onError(error)`          | 错误信息     | 编辑器发生错误           |

监听批注删除事件：

```js
const ed = DocEditor.init({
  container: "#editor-holder",
  baseUrl: "http://localhost:3001",
  docId: "文档ID",
  onCommentDelete({ id }) {
    console.log("被删除的批注 ID：", id);
  },
});
```

`onCommentDelete` 只在用户确认删除、编辑器完成本地批注及锚点移除后触发；取消删除不会触发。事件触发时已经安排自动保存，但不表示保存请求已经完成，持久化完成仍以 `onSave` 等保存结果为准。

额外属性：`ed.iframe` 获取 iframe 元素；`DocEditor.version` 当前为 `"3.0.0"`。
