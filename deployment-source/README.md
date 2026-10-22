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

## 修改环境变量

解压后修改根目录 `Dockerfile` 的 `ENV`：

| 变量 | 配置要求 |
| --- | --- |
| `TOKEN_SECRET` | 改为本环境随机密钥，可用 `openssl rand -hex 32` 生成；与业务系统签发 editor token 的密钥一致 |
| `BUSINESS_API_BASE_URL` | 容器可访问的业务后端地址，如 `https://api.example.com`；localhost 指容器自身 |
| `BUSINESS_DOCUMENT_CONTENT_PATH` | 实际文档读取接口路径，默认 `/doc-editor/{docId}/content`，保留 `{docId}` 占位符 |
| `BUSINESS_TOKEN_HEADER` | 按业务接口约定配置，默认 `token` |
| `BUSINESS_REQUEST_TIMEOUT_MS` | 业务接口超时，默认 30000 毫秒 |
| `BUSINESS_AUTO_COMMIT_ENABLED` | 默认 false，不启用定时向业务系统发布完整 DOCX |
| `VERSION_HISTORY_ENABLED` | 默认 false，关闭内部版本历史 |
| `STARTUP_DRAFT_PURGE_ENABLED` | 默认 false，不因服务启动而主动清理草稿 |
| `DATA_DIR` | 默认 `/app/data`，容器内工作目录，由应用自动创建 |

其他 ENV 为清理周期和磁盘监控配置，通常保持默认即可。ENV 中的密钥可被持有镜像的人查看，应由第三方自行填写并将构建后的镜像按含密钥的制品管理。

## 构建和运行

先用 ZIP 同目录下的校验文件检查传输完整性，再解压并进入源码根目录。Linux 示例：

```bash
# 替换为实际文件名；ZIP 与校验文件应放在同一目录。
sha256sum -c doc-editor-source-实际时间.zip.sha256
unzip doc-editor-source-实际时间.zip
cd doc-editor-source
# 在此编辑 Dockerfile 中的 ENV
docker build -t doc-editor:local .
docker run -d --name doc-editor --restart unless-stopped -p 3001:3001 doc-editor:local
docker logs --tail 100 doc-editor
curl -f http://127.0.0.1:3001/api/health
```

Dockerfile 是构建说明文件：先通过 `docker build` 构建镜像，再用 `docker run` 启动容器。不需要 Compose、runtime.env 或 `-v` 数据挂载。需要 sudo 的服务器，在 Docker 命令前加 sudo。

宿主机端口可通过 `-p 8080:3001` 改成 8080，容器内 PORT 保持 3001。通过服务器实际地址和映射端口访问 `/editor.html`；正式业务联调还需确认业务 API、token、反向代理和 WebSocket 可达，健康检查不能代替这些验证。

## 更新配置或代码

修改 Dockerfile 或源码后，在源码根目录执行：

```bash
docker build -t doc-editor:local .
# 首次部署无需执行 stop 和 rm；已有同名容器时执行。
docker stop doc-editor
docker rm doc-editor
docker run -d --name doc-editor --restart unless-stopped -p 3001:3001 doc-editor:local
```

仅执行 `docker restart` 不会加载重新构建的镜像或新配置。

## 文件存储和生命周期

- 工作文件写入容器内 `/app/data`，没有宿主机目录映射，也没有 Docker 数据卷。
- `docker stop` 后再 `docker start`、`docker restart` 或进程退出后的同一容器自动重启，通常保留容器可写层中的文件。
- `docker rm` 后重建容器会丢失旧容器中的工作文件；升级重建同样如此。已成功保存到业务后端的文件由业务后端保管。
- 不额外增加启动清空逻辑，且本 Dockerfile 设置 `STARTUP_DRAFT_PURGE_ENABLED=false`。应用原有规则仍生效：业务文档成功保存并关闭、最后一个连接退出后清理工作文件；不活跃业务文档达到 24 小时保留阈值后由清理任务回收。启动时也会执行一次超期检查，因此容器内存储不代表永久保留。

本 Dockerfile 未安装 LibreOffice；原生 DOCX 编辑可用，旧版 DOC/DOT 转换需要另外安装 LibreOffice。业务后端如使用私有 CA，需要将其证书加入镜像信任链；浏览器 PDF 功能依赖外部 CDN 可达。
