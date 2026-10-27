# 第三方源码构建部署说明

第三方只需安装并启动 Docker Engine，无需安装 Node.js，也无需手动创建宿主机数据目录。构建时需要访问基础镜像仓库和 npm 源。

## 交付材料

交付 `doc-editor-source-*.zip` 和对应的 `.sha256` 校验文件。ZIP 解压后的目录结构：

```text
doc-editor-source/
  Dockerfile
  .dockerignore
  DEPLOYMENT.md        # 本说明
  package.json
  package-lock.json
  server.js
  server/             # 完整服务端模块
  public/             # 完整页面、CSS、JS、SDK 及 public/package.json
```

源码包由当前工作目录中的文件生成，不依赖 Git 提交状态。维护方在项目根目录运行 `./deployment-source/package.ps1` 可重新生成，输出位于 `deliverables/`。

不交付 `.env`、业务数据、node_modules、Git 历史、IDE 配置、旧镜像 tar、旧部署 ZIP 或 Compose 文件。Dockerfile 已在源码包根目录，无需额外寻找其他版本。

## 默认配置与自动密钥

本包与业务后端一起交付，Dockerfile 已配置以下固定值，部署方无需修改即可构建运行：

```text
BUSINESS_API_BASE_URL=http://legalai-backend:8080/legalai
BUSINESS_DOCUMENT_CONTENT_PATH=/doc-editor/{docId}/content
BUSINESS_TOKEN_HEADER=token
```

编辑器容器须能通过 `legalai-backend:8080` 访问同批部署的后端；如分开使用 `docker run` 部署，应将两个容器接入同一自定义 Docker 网络，并为后端设置 `legalai-backend` 网络别名。环境或拓扑有变化时可通过 `docker run -e` 覆盖配置。

上述配置拼接后的下载和回写地址为 `http://legalai-backend:8080/legalai/doc-editor/实际合同ID/content`。业务后端必须部署包含 `DocEditorController` 的版本。使用 Compose 或 `docker run -e` 时，运行时环境变量会覆盖镜像默认值；请同步核对部署配置，避免仍指向开发环境或使用旧路径。已有 ZIP 不会随源码修改而更新，应重新运行打包脚本并使用新交付包。

无需生成或填写 `TOKEN_SECRET`。服务首次启动会自动生成 32 字节随机密钥，写入 `/app/data/.token-secret`（Linux 文件权限 0600）。同一容器重启时复用，文档清理不会删除此文件；删除并重建无数据卷容器时会生成新密钥，用户需要重新打开文档。该密钥仅用于编辑器内部短期文档令牌，不需要与业务后端共享，也不会写入镜像。

可选配置说明：

| 变量 | 配置要求 |
| --- | --- |
| `TOKEN_SECRET` | 可选运行时覆盖；默认自动生成并保存。多实例需统一密钥，但仍需另行处理共享存储、会话及 WebSocket 路由 |
| `BUSINESS_API_BASE_URL` | 本包固定为 `http://legalai-backend:8080/legalai`，包含后端上下文路径 |
| `BUSINESS_DOCUMENT_CONTENT_PATH` | 本包固定为 `/doc-editor/{docId}/content`，保留 `{docId}` 供服务替换为实际合同 ID |
| `BUSINESS_TOKEN_HEADER` | 本包固定为 `token` |
| `BUSINESS_REQUEST_TIMEOUT_MS` | 业务接口超时，默认 30000 毫秒 |
| `BUSINESS_AUTO_COMMIT_ENABLED` | 默认 false，不启用定时向业务系统发布完整 DOCX |
| `VERSION_HISTORY_ENABLED` | 默认 false，关闭内部版本历史 |
| `STARTUP_DRAFT_PURGE_ENABLED` | 默认 false，不因服务启动而主动清理草稿 |
| `DATA_DIR` | 默认 `/app/data`，容器内工作目录，由应用自动创建 |

其他 ENV 为清理周期和磁盘监控配置，通常保持默认即可。密钥文件不可读、不可写或内容损坏时服务启动失败，不会静默更换密钥；请恢复文件或显式设置运行时 `TOKEN_SECRET`。

## 构建和运行

先用 ZIP 同目录下的校验文件检查传输完整性，再解压并进入源码根目录。Linux 示例：

```bash
# 替换为实际文件名；ZIP 与校验文件应放在同一目录。
sha256sum -c doc-editor-source-实际时间.zip.sha256
unzip doc-editor-source-实际时间.zip
cd doc-editor-source
docker build -t doc-editor:local .
# legalai-network 为示例：替换为业务后端已加入的自定义 Docker 网络名称。
docker run -d --name doc-editor --network legalai-network --restart unless-stopped -p 3001:3001 doc-editor:local
docker logs --tail 100 doc-editor
curl -f http://127.0.0.1:3001/doc-editor/api/health
```

Dockerfile 是构建说明文件：先通过 `docker build` 构建镜像，再用 `docker run` 启动容器。不需要 Compose、runtime.env 或 `-v` 数据挂载。需要 sudo 的服务器，在 Docker 命令前加 sudo。

宿主机端口可通过 `-p 8080:3001` 改成 8080，容器内 PORT 保持 3001。通过服务器实际地址和映射端口访问 `/doc-editor/editor.html`；正式业务联调还需确认业务 API、token、反向代理和 WebSocket 可达，健康检查不能代替这些验证。

## 更新配置或代码

修改 Dockerfile 或源码后，在源码根目录执行：

```bash
docker build -t doc-editor:local .
# 首次部署无需执行 stop 和 rm；已有同名容器时执行。
docker stop doc-editor
docker rm doc-editor
docker run -d --name doc-editor --network legalai-network --restart unless-stopped -p 3001:3001 doc-editor:local
```

仅执行 `docker restart` 不会加载重新构建的镜像或新配置。

## 同源反向代理与统一前缀

页面、静态资源、REST API、WebSocket 和版本页统一使用 `/doc-editor`：

| 用途 | 路径 |
| --- | --- |
| 首页 / 编辑器 | `/doc-editor/` / `/doc-editor/editor.html` |
| SDK / 静态资源 | `/doc-editor/js/sdk.js` / `/doc-editor/css/app.css` |
| API / 健康检查 | `/doc-editor/api/documents` / `/doc-editor/api/health` |
| WebSocket | `/doc-editor/ws` |
| 版本 | `/doc-editor/version` |

SDK 的 `baseUrl` 可填写 `/doc-editor`；也兼容旧版只填写服务 origin 的方式，
自动补全统一前缀。原根路径保留为兼容入口，现有接入可逐步迁移。
API 文档 `/doc-editor/api-docs.html` 的 Swagger 已使用带前缀的服务地址。
业务后端的 `BUSINESS_DOCUMENT_CONTENT_PATH` 是独立的业务接口配置，不受此服务前缀影响。

编辑器仍返回 `X-Frame-Options: SAMEORIGIN`。通过业务前端自己的 Nginx 代理，
让父页面与 iframe 的浏览器来源一致即可，不需要移除安全响应头或配置来源白名单。
前端与 editor 容器加入同一 Docker 网络，editor 网络名为 `doc-editor`。
以下配置位于 Nginx `http` 上下文（如 `conf.d/default.conf`）：

```nginx
map $http_upgrade $doc_editor_connection {
    default upgrade;
    '' close;
}
server {
    listen 80;
    # 合并到业务前端现有的 server 中。
    location ^~ /doc-editor/ {
        proxy_pass http://doc-editor:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $doc_editor_connection;
        client_max_body_size 64m;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

`proxy_pass` 不添加末尾 `/`，保留 `/doc-editor/` 前缀；代理端不单独添加
`/js`、`/css`、`/api` 或 `/ws` 规则。先启动 editor 以便 Nginx 启动时解析上游名。
HTTPS 可在前端 Nginx 终止 TLS，浏览器所有编辑器请求仍通过当前前端来源。

## 文件存储和生命周期

- 工作文件写入容器内 `/app/data`，没有宿主机目录映射，也没有 Docker 数据卷。
- `docker stop` 后再 `docker start`、`docker restart` 或进程退出后的同一容器自动重启，通常保留容器可写层中的文件。
- `docker rm` 后重建容器会丢失旧容器中的工作文件；升级重建同样如此。已成功保存到业务后端的文件由业务后端保管。
- 不额外增加启动清空逻辑，且本 Dockerfile 设置 `STARTUP_DRAFT_PURGE_ENABLED=false`。应用原有规则仍生效：业务文档成功保存并关闭、最后一个连接退出后清理工作文件；不活跃业务文档达到 24 小时保留阈值后由清理任务回收。启动时也会执行一次超期检查，因此容器内存储不代表永久保留。

本 Dockerfile 未安装 LibreOffice；原生 DOCX 编辑可用，旧版 DOC/DOT 转换需要另外安装 LibreOffice。业务后端如使用私有 CA，需要将其证书加入镜像信任链；浏览器 PDF 功能依赖外部 CDN 可达。
