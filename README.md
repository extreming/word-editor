# doc-editor 在线文档编辑器

基于浏览器的在线文档编辑器，提供 DOCX 导入导出、文字排版、表格图片、批注、修订、WebSocket 文档同步，以及用于业务页面集成的 JavaScript SDK。

前端使用原生 JavaScript ES Modules，无需打包；Node.js 服务端依赖 `jsdom`，复用前端 DOCX 解析逻辑完成 DOCX 与 HTML 转换。LegalAI 业务后端负责正式文件存储，编辑器负责编辑过程中的工作数据。

## 文档入口

- [产品手册](docs/doc-editor产品手册.md)
- [JavaScript SDK 集成说明](docs/JS%20SDK集成方法说明.md)
- [集成部署指南](docs/doc-editor集成部署指南.md)

本文以当前工作区代码及根目录 `docker-compose.yml` 为准。其他分支或已部署环境可能使用不同配置。

## 主要功能与边界

| 功能 | 说明 |
| --- | --- |
| DOCX 导入导出 | 支持常见段落、标题、编号、表格、图片、超链接、页面设置及部分批注和修订 |
| 文本编辑 | 字体字号、颜色、对齐、缩进、列表、查找替换、格式刷、撤销重做 |
| 页面排版 | 纸张尺寸、方向、页边距、分页、页眉页脚及页码 |
| 表格与图片 | 表格增删行列、合并拆分、底纹；图片插入、尺寸与布局调整 |
| 批注与修订 | 选区批注、回复、解决状态、文字插入删除修订及接受拒绝操作 |
| 自动保存 | 草稿写入编辑器工作目录；通过版本号检测冲突 |
| 文档同步 | WebSocket 在线状态和文档更新；不是字符级 OT/CRDT 合并 |
| 版本历史 | 服务端可配置，最多 10 份、最近 3 天；当前 Compose 关闭 |
| SDK 集成 | iframe 嵌入、文档操作、保存关闭、事件回调、临时选区高亮 |
| 语言 | 中文和英文；部分 PDF 控件仍为英文 |
| PDF | 预览、批注、印章、签名放置及有限文本修改；单独下载结果 |

复杂 DOCX 对象可能以只读预览或占位符显示，并通过原始 OOXML 保留机制参与导出；这不保证与 Microsoft Word 完全一致。批注回复在 DOCX 导出时会合并为文本，回复关系和解决状态不能完整往返。修订不覆盖所有格式和对象变更。

PDF 功能按需从 CDN 加载 pdf.js 和 pdf-lib。文本修改采用遮盖后重绘，中文、原字体和复杂布局支持有限，不属于可靠的脱敏或 OCR。PDF 签名采用浏览器密钥和自定义元数据，不是标准证书式 PDF 数字签名。PDF 保存不经过 Word 草稿和业务回写流程。

当前镜像未安装 LibreOffice。原生 DOCX 不依赖它；旧版 `.doc`、`.dot` 的服务端转换需要另行安装 `soffice`，缺少时返回 501。仅设置 `SOFFICE_PATH` 不会安装转换器。其他格式和复杂 Word 排版需使用业务样本单独验证。

## Docker Compose 部署

### 本地生成交付包

本地安装 Node.js 22，并确保 `tar` 命令可用（Windows 自带 tar，Linux 通常已安装）。运行：

```bash
npm run build
```

脚本不需要 Docker 引擎，也不需要先执行 `npm ci`，会在 `deliverables/` 下生成带北京时间日期、时分秒和毫秒的 ZIP，例如：

```text
deliverables/doc-editor-deploy-20261028-153000-123.zip
```

ZIP 根目录仅包含三个文件：

```text
doc-editor-source.tar   package.json、package-lock.json、server.js、server/、public/
Dockerfile              解压源码、安装依赖并构建镜像
compose.yml             来自根目录 docker-compose.yml，保留业务参数和 CA 挂载
```

源码包直接包含运行所需文件，不带额外顶层目录，不包含 `.env`、密钥、`node_modules`、工作数据、Git、测试或历史交付包。打包采用运行文件白名单，符号链接会导致打包失败，避免意外引入外部文件。输出目录不提交到 Git。

内层使用普通 `.tar` 即可：Dockerfile 通过 `tar -xf` 解压，外层 ZIP 统一压缩。使用 `.tar.gz` 也可行，但会产生重复压缩，当前无需增加这一层。打包脚本在临时目录生成源码归档，不修改本地源码。

将 ZIP 上传到服务器并解压到独立的交付目录；无需手动解压内层源码 tar。不要把交付文件与其他版本的 `docker-compose.yml` 混放，部署命令显式指定 `compose.yml`：

```bash
mkdir -p /opt/doc-editor/releases/20261028-153000
unzip doc-editor-deploy-20261028-153000-123.zip -d /opt/doc-editor/releases/20261028-153000
cd /opt/doc-editor/releases/20261028-153000

docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d --build
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail=100 doc-editor
```

示例中的版本目录可按实际日期调整。更新同一服务应保持 Compose 项目名一致；可在所有部署命令中统一添加 `-p doc-editor`，例如 `docker compose -p doc-editor -f compose.yml up -d --build`。已有部署应沿用原项目名，避免与原容器冲突。

### 部署前提

- Linux 服务器已安装 Docker 和 Docker Compose。
- 镜像构建时能获取 Node.js 基础镜像及 npm 依赖。
- 容器能解析并访问配置中的 GTM 业务后端。
- 宿主机存在 `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`，且其中包含业务后端所需的 CA。

在服务器解压交付 ZIP 后，进入包含 `compose.yml`、`Dockerfile` 和源码 tar 的目录，例如 `/opt/doc-editor/services`，然后执行：

```bash
cd /opt/doc-editor/services

docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d --build
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail=100 doc-editor

curl -f http://127.0.0.1:3001/api/health
curl -f http://127.0.0.1:3001/version
```

`/api/health` 返回 `{"ok":true,"uptime":...}` 表示进程可访问；`/version` 展示 `package.json` 中的版本号。它们不代表业务文件下载和保存已经验证通过，还需完成一次真实的打开、编辑和保存回写。

### 配置文件分工

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 从源码 tar 解压后构建镜像，安装服务端依赖，设置 `HOST=0.0.0.0`、`PORT=3001`、`DATA_DIR=/app/data` 通用默认值 |
| `docker-compose.yml` | 直接填写业务地址、鉴权头、CA 路径和运行策略，并配置端口、证书挂载与重启策略 |
| `.env` | 本地 npm 启动使用，不参与当前 Compose 服务的参数注入；不应提交到仓库 |
| `.dockerignore` | 排除本地环境文件、数据、依赖目录等构建上下文内容 |

当前 Compose 没有 `env_file` 或 `${...}` 参数插值，部署无需创建 `.env`，也无需手动传入环境变量。仓库当前未提供 `.env.example`。

Compose 使用的业务配置如下：

```yaml
environment:
  BUSINESS_API_BASE_URL: "https://legalai-gtm-backend-dev.t-sy-in.earth.xcloud.lenovo.com/legalai"
  BUSINESS_DOCUMENT_CONTENT_PATH: "/doc-editor/{docId}/content"
  BUSINESS_TOKEN_HEADER: "token"
  NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/host-ca-bundle.crt"
```

编辑器最终访问：

```text
GET  https://legalai-gtm-backend-dev.t-sy-in.earth.xcloud.lenovo.com/legalai/doc-editor/{docId}/content
POST https://legalai-gtm-backend-dev.t-sy-in.earth.xcloud.lenovo.com/legalai/doc-editor/{docId}/content
```

保留 `{docId}` 占位符，服务端会替换为实际文档 ID。业务请求使用 `token` 请求头转发用户凭证。业务凭证由集成页面提供，不应写死在镜像或 Compose 中。

### CA 证书挂载

当前 Compose 保留以下只读挂载：

```yaml
volumes:
  - /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem:/etc/ssl/certs/host-ca-bundle.crt:ro
```

挂载让容器能读取宿主机 CA 证书包，`NODE_EXTRA_CA_CERTS` 让 Node.js 额外信任其中的 CA，用于验证业务后端 HTTPS 证书。它不会关闭证书验证，也不配置浏览器访问编辑器时使用的 HTTPS 证书。

不同 Linux 发行版的 CA 文件位置可能不同，应将宿主机路径调整为实际存在且包含所需 CA 的文件。

### 浏览器访问与反向代理

当前端口映射为 `127.0.0.1:3001:3001`，仅宿主机本机可直接访问。外部浏览器通过 Nginx 等反向代理访问编辑器域名：

```text
浏览器 → 编辑器 HTTPS 域名 → Nginx → 127.0.0.1:3001
```

反向代理需支持 `/ws` WebSocket。前端使用 `/api/...`、`/js/...` 等绝对路径，建议部署到独立域名根路径；不能只修改 SDK 的 `baseUrl` 就完成子路径部署。HTTPS、WebSocket 及 iframe 策略示例见集成部署指南。

### 更新与重启

仅修改 Compose 参数后执行：

```bash
docker compose -f compose.yml up -d
```

更新源码或 Dockerfile 后，先在本地重新执行 `npm run build`，上传并解压新交付 ZIP，再执行：

```bash
docker compose -f compose.yml up -d --build
docker compose -f compose.yml logs --tail=100 doc-editor
```

`docker compose -f compose.yml restart` 只重启现有容器，不更新环境变量或代码镜像。参数或镜像变化可能导致容器被重新创建，更新前应让用户完成正式保存。

## 文件存储与清理

### 工作数据存放位置

当前 Docker 部署不挂载 `/app/data`，以下文件保存在容器自身的可写层中：

| 文件 | 内容 |
| --- | --- |
| `<id>.json` | 文档状态、正文草稿、页面设置、版本号及业务元数据 |
| `<id>.source.docx` | 导入时保留的原始 DOCX 源包 |
| `<id>.docx` | 当前生成的 DOCX 文件 |
| `<id>.versions.json` | 启用版本历史时的快照 |
| `.token-secret` | 自动生成的编辑器内部签名密钥 |
| `cleanup-audit.log` | 清理与磁盘检查审计记录 |

应用启动时自动创建工作目录，无需准备宿主机数据目录。旧的 `HOST_DATA_DIR` 已不参与当前部署；原宿主机文件不会自动迁移或删除。

### 重启与重建的区别

| 操作 | 文件影响 |
| --- | --- |
| 重启同一个容器 | 容器文件仍存在，但当前启动清理会清除正文草稿、批注、页面设置、修订状态和历史 |
| 删除或重新创建容器 | 容器内工作文件和自动密钥丢失；用户需重新打开文档 |
| 正式保存到业务后端 | 文件由业务系统保存，不受编辑器容器删除影响 |

当前 `STARTUP_DRAFT_PURGE_ENABLED="true"`。启动时清除草稿载荷与历史，保留生命周期元数据和 DOCX 文件；`.token-secret` 不属于文档清理对象，同一容器重启可复用密钥。更换容器会生成新密钥，旧编辑器令牌失效。

`TOKEN_SECRET` 只用于编辑器内部短期文档令牌，不需要与业务后端共享，不写入镜像。密钥文件损坏时服务启动失败，不会静默轮换。

### 关闭与到期清理

- 业务文档成功执行 SDK `close()`，关闭提交版本与当前及已提交版本一致，且最后一个 WebSocket 离开后，可立即清除工作文件。
- 默认每天扫描一次，按 24 小时非活动阈值清理业务工作文档，跳过活跃房间；未确认回写草稿也可能到期删除。
- 24 小时是扫描时判断的阈值，不是精确删除时刻。该周期扫描不用于所有独立文档。
- 当前关闭内部版本历史；启用后最多保留最近 3 天的 10 份快照，关闭清理仍可能删除它们。
- 每 5 分钟检查数据所在文件系统的使用率，在 70% 和 85% 阈值记录告警。

工作目录不应作为正式文档档案库。未正式保存的编辑内容不能依靠重启、重建或浏览器关页来保证保留。

## 本地开发

需要 Node.js 22。当前 npm 启动脚本显式读取 `.env`，首次本地运行需自行创建该文件，例如：

```dotenv
BUSINESS_API_BASE_URL=https://legalai-gtm-backend-dev.t-sy-in.earth.xcloud.lenovo.com/legalai
BUSINESS_DOCUMENT_CONTENT_PATH=/doc-editor/{docId}/content
BUSINESS_TOKEN_HEADER=token
```

如需本地持久复用草稿，可额外设置 `STARTUP_DRAFT_PURGE_ENABLED=false`；直接启动服务时默认开启启动清理。本地 Node 进程的数据默认写入项目的 `data` 目录。

安装并启动：

```bash
npm ci
npm start
```

访问 `http://localhost:3001`。常用页面：

| 页面 | 地址 |
| --- | --- |
| 首页和演示 | `/` |
| 独立编辑器 | `/editor.html` |
| SDK 嵌入示例 | `/embed-example.html` |
| 全屏示例 | `/fullscreen-test.html` |
| 接口说明 | `/api-docs.html` |
| 进程健康 | `/api/health` |
| 应用版本 | `/version` |

本地对接不受信任的 HTTPS 后端时，可使用开发命令：

```bash
npm run dev
```

该命令关闭当前 Node 进程所有 HTTPS 请求的证书验证，仅用于本地开发；`NODE_ENV=production` 时拒绝启动。常规 `npm start` 保留正常 TLS 验证，必要时为本地 Node 配置可信 CA。

也可直接通过 `node server.js` 启动，此方式不自动读取 `.env`，需要自行设置进程环境。PowerShell 下修改监听端口示例：

```powershell
$env:PORT = "4000"
npm start
```

## 配置参数

下表区分代码默认值与当前 Compose 部署值。Dockerfile 将容器监听地址改为 `0.0.0.0`、工作目录改为 `/app/data`。

| 参数 | 代码默认值 | 当前 Compose 部署 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | 继承镜像的 `0.0.0.0` / `3001` |
| `DATA_DIR` | 项目 `data` 目录 | 继承镜像的 `/app/data`，无数据挂载 |
| `BUSINESS_API_BASE_URL` | 未设置 | GTM 开发后端 HTTPS 地址 |
| `BUSINESS_DOCUMENT_CONTENT_PATH` | `/doc-editor/{docId}/content` | 同左 |
| `BUSINESS_TOKEN_HEADER` | `token` | 同左 |
| `BUSINESS_REQUEST_TIMEOUT_MS` | `30000` | `30000`，最低 1000 毫秒 |
| `BUSINESS_AUTO_COMMIT_ENABLED` | `false` | `false`，不影响草稿自动保存 |
| `BUSINESS_AUTO_COMMIT_INTERVAL_MS` | `300000` | `300000`，启用定时回写时最低 60 秒 |
| `VERSION_HISTORY_ENABLED` | `true` | `false` |
| `STARTUP_DRAFT_PURGE_ENABLED` | `true` | `true` |
| `DATA_RETENTION_HOURS` | `24` | `24` |
| `DATA_CLEANUP_INTERVAL_MS` | `86400000` | `86400000` |
| `DISK_CHECK_INTERVAL_MS` | `300000` | `300000` |
| `DISK_WARNING_PERCENT` / `DISK_CRITICAL_PERCENT` | `70` / `85` | `70` / `85` |
| `NODE_EXTRA_CA_CERTS` | 未设置 | `/etc/ssl/certs/host-ca-bundle.crt` |
| `TOKEN_SECRET` | 自动生成并复用 | 不显式设置，保存在容器内部 |
| `SOFFICE_PATH` | 从 PATH 查找 `soffice` | 未设置；当前镜像不安装 LibreOffice |

当前服务固定使用本地文件系统实现，不读取 `STORAGE_DRIVER`，因此无需配置此变量。旧 `LEGALAI_*` 业务配置名作为兼容别名保留，同时设置时以对应 `BUSINESS_*` 为准。

## SDK 集成与业务保存

页面加载编辑器的 `sdk.js`，为容器设置明确高度，使用稳定的业务文档 ID 和当前用户业务凭证初始化：

```html
<div id="editor" style="height: 80vh"></div>
<script src="https://编辑器域名/js/sdk.js"></script>
<script>
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const editor = DocEditor.init({
    container: "#editor",
    baseUrl: "https://编辑器域名",
    docId: contractId,           // 替换为业务文档 ID
    businessToken: legalAiToken, // 使用当前用户的业务凭证
    tenantId,
    documentTitle: contractName,
    fileType: "docx",
    locale: "zh",
    history: false,
    onReady: resolveReady,
    onSave(info) { console.log("保存结果", info); },
    onError(error) { console.error(error); },
  });

  // 在业务页面的关闭动作中调用；保存失败时保留编辑器。
  async function closeEditor() {
    await ready;
    await editor.close();
    editor.destroy();
  }
</script>
```

示例中的业务变量由宿主页面提供。SDK 方法应在 `onReady` 后调用。`locale` 支持 `zh`、`en`；`mode: "view"` 控制只读界面，不是服务端权限边界。

业务流程：

1. 编辑器使用业务凭证调用后端 GET 文件接口，验证访问后签发文档范围的短期编辑令牌。
2. 编辑过程中的自动保存仅写编辑器工作目录。
3. `Ctrl+S`、菜单保存或 SDK `save()` / `close()` 等操作触发生成 DOCX，并通过后端 POST 文件接口正式回写。
4. 宿主页面等待 `close()` 成功后，再执行 `destroy()` 或离开页面。

`close()` 保存但不移除 iframe；`destroy()` 移除实例但不保存。浏览器 `pagehide` 仅尝试尽力提交，无法可靠等待，不等同于成功调用 `close()`。

业务凭证仅在当前服务进程内存中保存，不写入文档元数据。独立编辑文档会以 `skipped: "not-legalai"` 跳过业务回写。`onSave` 回调、下载导出文件或显示“已保存”，都不能单独证明业务后端已经更新，应检查返回结果并验证正式文件。

临时高亮可使用 `highlightSelection()` 和 `clearHighlight()`；需先有非空选区且浏览器支持 CSS Custom Highlight API。高亮不写入正文、导出文件或撤销历史。SDK 还提供内容操作、查找、表格图片、批注修订和页面设置等方法，详见 SDK 文档。

## 服务端接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 进程健康 |
| GET / POST | `/api/documents` | 工作文档列表、新建 |
| POST | `/api/documents/import` | 导入文件 |
| GET / PUT / DELETE | `/api/documents/:id` | 读取、更新、删除工作文档 |
| GET / PUT | `/api/documents/:id/docx` | 读取或上传 DOCX |
| GET / PUT | `/api/documents/:id/content` | 读取或替换 HTML 内容 |
| GET | `/api/documents/:id/text` | 读取纯文本 |
| POST | `/api/documents/:id/insert-html`、`/api/documents/:id/insert-text` | 向已保存内容追加 HTML 或文本 |
| PUT | `/api/documents/:id/title` | 重命名 |
| GET / PUT | `/api/documents/:id/meta` | 文档元数据 |
| GET | `/api/documents/:id/export?fmt=docx` | 导出；也支持 `html`、`txt` |
| GET / POST | `/api/documents/:id/comments` | 读取或添加批注 |
| GET / PUT | `/api/documents/:id/track-changes`、`/api/documents/:id/page-setup` | 修订开关、页面设置 |
| GET | `/api/documents/:id/versions`、`/api/documents/:id/versions/:n` | 历史列表、快照 |
| POST | `/api/documents/:id/restore` | 恢复快照 |
| POST | `/api/format` | 格式转换 |
| POST | `/api/integrations/legalai/session` | 创建业务文档编辑会话 |
| POST | `/api/documents/:id/commit` | 生成 DOCX 并正式回写 |
| WebSocket | `/ws` | 文档在线状态与更新同步 |

详细请求格式见 `/api-docs.html`、`server.js` 和 `public/js/api-client.js`。REST 追加操作修改已保存内容，与 SDK 在当前光标处插入不同。普通编辑保存携带 `baseRev`，冲突返回 409；不要假设所有辅助接口具有相同的并发约束或批注锚定效果。请求体上限为 64 MB，Base64 开销会占用该额度。

协作房间和业务会话保存在进程内，当前按单实例部署。增加副本数前需另行处理共享存储、签名密钥、会话和 WebSocket 路由。

## 项目结构

```text
scripts/build-delivery.cjs 自动生成三文件部署 ZIP
deliverables/              带日期时间的交付 ZIP（不提交）
Dockerfile                 解压源码 tar、镜像构建与通用默认值
docker-compose.yml         运行参数、端口与 CA 挂载
server.js                  HTTP、WebSocket、文档接口与业务回写
server/
  storage.js               工作目录文件读写
  tokenSecret.js           自动生成和复用签名密钥
  scopedAuth.js            文档范围短期令牌
  docxNode.mjs             服务端 DOCX 与 HTML 转换
  docConvert.js            旧版 DOC/DOT 转换
  dataLifecycle.js         工作文件清理与磁盘审计
  dev.js                   本地开发启动入口
public/
  editor.html              独立编辑器
  embed-example.html       SDK 示例
  js/sdk.js                嵌入 SDK
  js/api-client.js         REST 客户端
  js/docx.js               DOCX 与 OOXML 处理
  js/main.js               编辑器主流程
  js/store.js              自动保存与文档同步
  js/i18n.js               国际化
  js/pdf-view.js           PDF 功能
docs/                      产品、SDK 与部署文档
tests/                     Node.js 自动化测试
```

公共 SDK 使用 `DocEditor` 和 `DocEditorRestClient`；旧 `Docflow`、`DocflowRestClient` 名称保留为兼容别名。

## 检查与验证

```bash
npm test
node --check server.js
git diff --check
```

当前测试文件覆盖选定的 DOCX 编号、空白字符和签名密钥行为。这些测试不能替代浏览器交互、复杂 Word 排版、PDF、SDK 关闭和业务后端回写验证。镜像构建、服务器部署及真实业务联调应分别确认结果。

## 常见问题

| 问题 | 排查方向 |
| --- | --- |
| 服务器启动了，浏览器访问不到 | 当前端口只绑定服务器回环地址，检查 Nginx、域名、HTTPS 和 WebSocket 转发 |
| 编辑器显示已保存，但业务文件没变化 | 区分草稿自动保存、下载导出和正式回写；检查提交结果及业务接口日志 |
| 重启后草稿不见了 | 当前启动草稿清理为 `true`；还需区分重启与容器重建 |
| 更新容器后文档令牌失效 | 工作数据及密钥在容器内，重建后需重新打开文档 |
| 找不到历史版本 | 当前 Compose 关闭版本历史；SDK `history: false` 也会隐藏入口 |
| 业务 HTTPS 请求证书错误 | 检查 CA 挂载文件、内容及 `NODE_EXTRA_CA_CERTS`；浏览器证书信任与容器出站信任是两回事 |
| DOC/DOT 返回 501 | 镜像未安装 LibreOffice；可先转换为 DOCX 或自定义镜像安装转换器 |
| PDF 加载或保存失败 | 检查 CDN、浏览器能力及字体限制，使用 PDF 工具栏下载结果 |
| 本地 npm 启动提示缺少 `.env` | 创建本地 `.env`；Docker Compose 部署不需要该文件 |
| macOS 启动提示 `EPERM: process.cwd failed` | 检查受保护目录权限；可使用 `run.sh` 或 Docker，将数据目录设到可写位置 |

## 常用快捷键

- `Ctrl/⌘ + B / I / U`：加粗、斜体、下划线。
- `Ctrl/⌘ + F`、`Ctrl/⌘ + H`：查找、替换。
- `Ctrl/⌘ + S`：保存；`Ctrl/⌘ + Shift + S`：导出 DOCX。
- `Ctrl/⌘ + P`：打印或通过浏览器另存为 PDF。
- `Ctrl/⌘ + Z`、`Ctrl/⌘ + Y`：撤销、重做。
- `Ctrl/⌘ + Alt + M`：添加批注；`Ctrl/⌘ + Shift + E`：切换修订。
