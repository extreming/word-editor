根据当前 [sdk.js](/D:/Workspace/code/legalai-gtm/word-editor/public/js/sdk.js:69)，第三方页面使用的是 **`DocEditor` iframe SDK**，包含 **1 个初始化方法、68 个实例方法**。

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

初始化参数包括：`container`、`baseUrl`、`docId`、`mode`、`toolbar`、`statusbar`、`user`、`documentTitle`、`fileType`、`tenantId`、`history`、`businessToken`，以及下文的事件回调。

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
| `find(query, options)`                    | 查找、选中并滚动到首个匹配，不添加高亮，返回 `{matches}`        |
| `highlightSelection()`                   | 当前选区临时显示橘底白字，返回 `{ok:true}`                     |
| `clearHighlight()`                       | 清除 SDK 临时高亮、恢复原有样式，返回 `{ok:true}`              |
| `replaceAll(query, replacement, options)` | 全部替换，返回 `{replaced}`                                   |

`find`、`replaceAll` 的 `options` 支持 `{matchCase, regex}`。

```js
const { matches } = await ed.find("待定位的文本", { matchCase: false });
if (matches > 0) await ed.highlightSelection(); // 橘底 #ff9632、白字 #fff
await ed.clearHighlight(); // 保留选区和文本原有的颜色、底色、字体等样式
```

`highlightSelection()` 只作用于当前选区（也可以手动选择文本），不自动高亮全部匹配；再次调用会替换上一次 SDK 高亮。`clearHighlight()` 可重复调用，不清除文档自身的底色或查找面板的高亮。没有有效文本选区时，`highlightSelection()` 会拒绝 Promise。

高亮使用 [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)，不修改正文 HTML，不进入保存、导出或撤销记录；切换文档或整体替换正文时自动清除。不支持该 API 的浏览器调用 `highlightSelection()` 会明确报错，`find()` 和 `clearHighlight()` 仍可使用。浏览器原生选区提示仍会保留；编辑器查找面板手动搜索仍保留原有高亮。

**注意：**当前没有独立的 `replaceSelection()` 方法；`insertText()` / `insertHtml()` 不要求必须有选区。当前 `getSelectedText()` 返回的 `html` 字段实际也是文本，并非保留格式的 HTML。

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

| 回调               | 触发时机         |
| ------------------ | ---------------- |
| `onReady(info)`    | 编辑器初始化就绪 |
| `onDocument(info)` | 文档打开或切换   |
| `onChange(info)`   | 文档内容变化     |
| `onSave(info)`     | 保存事件         |
| `onPresence(info)` | 协作在线状态变化 |
| `onError(error)`   | 错误事件         |

额外属性：`ed.iframe` 获取 iframe 元素；`DocEditor.version` 当前为 `"3.0.0"`。

以上已对照 [main.js 的 SDK 命令处理](/D:/Workspace/code/legalai-gtm/word-editor/public/js/main.js:2161) 核对。项目另有 [REST 客户端 api-client.js](/D:/Workspace/code/legalai-gtm/word-editor/public/js/api-client.js:1)，它直接操作服务端文档，不属于上述嵌入页面的 SDK 方法。
