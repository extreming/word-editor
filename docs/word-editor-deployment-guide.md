# word-editor 内网服务器部署指南

> 首次部署日期：2026-08-18
> 文档更新日期：2026-08-24
> 操作系统：Rocky Linux 8.10
> 部署用户：`aiadmin`
> 内网域名：`https://legaloffice.lenovo.com/`
> 服务器地址：`10.195.6.81`
> 应用端口：`127.0.0.1:3001`

## 1. 部署结果

word-editor 已部署在公司内网服务器，并可通过以下地址从办公电脑访问：

```text
https://legaloffice.lenovo.com/
```

当前访问链路为：

```text
用户浏览器
  -> 内网 DNS：legaloffice.lenovo.com -> 10.195.6.81
  -> Nginx：80/443
  -> HTTPS 终止和反向代理
  -> 127.0.0.1:3001
  -> word-editor Docker 容器
```

word-editor 的 `3001` 端口只绑定服务器回环地址，不直接对内网开放；外部访问统一经过 Nginx。

## 2. 目录规划

部署目录统一放在 `aiadmin` 用户目录下：

```text
/home/aiadmin/word-editor/
├── services/       # word-editor 源码、Dockerfile、docker-compose.yml
└── data/           # 编辑器草稿、版本和生成 DOCX 等工作数据
```

创建目录：

```bash
mkdir -p /home/aiadmin/word-editor/services
mkdir -p /home/aiadmin/word-editor/data
```

进入服务目录：

```bash
cd /home/aiadmin/word-editor/services
```

回到当前用户主目录可以使用：

```bash
cd ~
```

## 3. 通过 SFTP 上传源码

服务器无法正常通过 Git 下载源码，可能受到内网网络、代理或 GitHub 访问策略影响。因此本次没有在服务器执行 `git clone`，而是采用以下方式：

1. 在可访问 GitHub 的电脑上获取 word-editor 源码；
2. 在本地确认源码中包含运行所需文件；
3. 通过 SFTP 将源码上传到：

```text
/home/aiadmin/word-editor/services
```

上传完成后检查目录：

```bash
cd /home/aiadmin/word-editor/services
ls -lah
```

至少需要确认应用入口和容器构建文件位于当前目录，例如：

```text
server.js
public/
Dockerfile
docker-compose.yml
```

需要避免 SFTP 上传后多嵌套一层源码目录。例如，如果实际文件变成：

```text
/home/aiadmin/word-editor/services/word-editor-main/server.js
```

则 Compose 的构建上下文需要相应调整，或者将源码移动到预期的 `services` 目录。

## 4. Docker Compose 配置

### 4.1 固定 `TOKEN_SECRET` 和 LegalAI 地址

`TOKEN_SECRET` 用于签名和验证 word-editor 内部的短期文档令牌，它不是 LegalAI 登录 Token。当前 Dev 部署根据项目要求将它和 `LEGALAI_BASE_URL` 直接写在 `docker-compose.yml` 中，不再依赖 `.env`。

每个环境仍应使用不同的 32 字节随机密钥。需要轮换时可以生成新值，再替换 Compose 中的 `TOKEN_SECRET`：

```bash
openssl rand -hex 32
```

如果服务器没有 OpenSSL，也可以使用 Node.js：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Compose 中的配置形式：

```yaml
TOKEN_SECRET: '替换为64位随机十六进制字符串'
LEGALAI_BASE_URL: 'https://legalai-gtm-backend-dev.t-sy-in.earth.xcloud.lenovo.com/legalai'
```

注意：

- 不要在工单、聊天或截图中发送 `TOKEN_SECRET`；
- 密钥会进入 Compose 文件和代码历史，仓库访问权限必须受控；
- 轮换 `TOKEN_SECRET` 会立即使已经签发的文档临时令牌失效，轮换后需要重新打开编辑器会话；
- 复制到测试或生产环境时，必须同时替换密钥和 `LEGALAI_BASE_URL`；

### 4.2 内网 CA 证书

LegalAI 后端使用公司内网证书。Rocky Linux 宿主机已经维护了系统 CA Bundle，Compose 直接将以下宿主机文件只读挂载到容器：

```text
/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem
```

部署前确认它是普通文件并包含证书：

```bash
sudo stat -c 'type=%F size=%s' /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem
sudo grep -m1 'BEGIN CERTIFICATE' /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem
```

这是宿主机的受信任 CA 证书库，不是 Nginx 为 `legaloffice.lenovo.com` 配置的服务端证书或私钥。不要将 Nginx 私钥挂载给 word-editor。如果 LegalAI HTTPS 证书以后已被容器默认 CA 信任，可以从 Compose 中同时删除该挂载和 `NODE_EXTRA_CA_CERTS`。

### 4.3 Compose 配置

`/home/aiadmin/word-editor/services/docker-compose.yml` 使用以下核心配置：

```yaml
services:
  word-editor:
    build:
      context: .
      dockerfile: Dockerfile
    image: word-editor
    container_name: word-editor
    ports:
      - '127.0.0.1:3001:3001'
    volumes:
      - /home/aiadmin/word-editor/data:/app/data:Z
      - /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem:/etc/ssl/certs/host-ca-bundle.crt:ro
    environment:
      HOST: '0.0.0.0'
      PORT: '3001'
      DATA_DIR: '/app/data'
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/host-ca-bundle.crt'
      TOKEN_SECRET: '替换为64位随机十六进制字符串'
      LEGALAI_BASE_URL: 'https://legalai-gtm-backend-dev.t-sy-in.earth.xcloud.lenovo.com/legalai'
      LEGALAI_CONTENT_PATH: '/doc-editor/{docId}/content'
      LEGALAI_TOKEN_HEADER: 'token'
      LEGALAI_REQUEST_TIMEOUT_MS: '30000'
      LEGALAI_AUTO_COMMIT_ENABLED: 'false'
      VERSION_HISTORY_ENABLED: 'true'
      DATA_RETENTION_HOURS: '24'
      DATA_CLEANUP_INTERVAL_MS: '86400000'
      STARTUP_DRAFT_PURGE_ENABLED: 'true'
      DISK_CHECK_INTERVAL_MS: '300000'
      DISK_WARNING_PERCENT: '70'
      DISK_CRITICAL_PERCENT: '85'
    restart: unless-stopped
```

说明：

- `127.0.0.1:3001:3001`：仅允许服务器本机访问应用端口，由 Nginx 对外代理；
- `/home/aiadmin/word-editor/data:/app/data`：保存编辑器草稿、版本和生成的 DOCX；这些是编辑器工作数据，不是 LegalAI 正式业务文档的最终存储；
- `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`：直接复用宿主机系统 CA 信任库，只读挂载，不属于 word-editor 发布文件；
- `TOKEN_SECRET`、`LEGALAI_BASE_URL`：当前 Dev 部署直接固定在 Compose 中，不再依赖同目录 `.env`；复制到其他环境时必须替换为该环境的独立密钥和后端地址；
- `LEGALAI_AUTO_COMMIT_ENABLED=false`：自动保存仍写本地草稿，只有保存按钮、`Ctrl+S`、SDK `save()/close()` 等正式保存动作才回写 LegalAI；
- `VERSION_HISTORY_ENABLED=true`：保留内部历史版本；如果某环境明确不需要历史功能，可以改为 `false`；
- 历史开启时，每个文档最多保留 10 份且只保留最近 3 天；
- 成功执行 SDK `close()` 且该文档 WebSocket 在线人数归零后，会立即删除草稿、当前 DOCX、原始 DOCX 和历史文件；
- 其他非活动 LegalAI 工作数据按 `DATA_RETENTION_HOURS=24` 清理；未确认成功回写的草稿也至少保留 24 小时；
- 服务启动时清除草稿正文和全部历史，保留最小生命周期元数据供审计及后续 DOCX 回收；
- 每日清理和磁盘检查写入 `DATA_DIR/cleanup-audit.log`；数据盘使用率达到 70% 输出 warning，达到 85% 输出 critical；
- `:Z`：为 SELinux 环境添加挂载标签兼容性；本机检查时 SELinux 为 `Disabled`，保留该参数不影响使用；
- `restart: unless-stopped`：Docker 服务重启后自动恢复容器，除非容器被人工停止；
- 文件底部不再声明未使用的顶级命名卷。

检查 Compose 展开后的最终配置：

```bash
cd /home/aiadmin/word-editor/services
sudo docker compose config --quiet
```

`--quiet` 只检查配置，不把展开后的 `TOKEN_SECRET` 输出到终端。不要将普通 `docker compose config` 的完整输出粘贴到日志、工单或聊天中。

容器启动后再通过第 6 节的 `docker inspect` 命令确认数据目录挂载，不需要为了查看挂载而输出包含密钥的完整 Compose 展开结果。

## 5. 构建并启动 word-editor

当前 `aiadmin` 用户没有直接访问 `/var/run/docker.sock` 的权限，直接执行 Docker 命令曾出现：

```text
permission denied while trying to connect to the Docker daemon socket
```

因此本次部署统一使用 `sudo docker ...`：

```bash
cd /home/aiadmin/word-editor/services
sudo docker compose up -d --build
```

查看容器：

```bash
sudo docker ps --filter name=word-editor
```

查看日志：

```bash
sudo docker compose logs --tail=100 word-editor
```

从服务器本机验证应用端口：

```bash
curl -v http://127.0.0.1:3001/
curl -fsS http://127.0.0.1:3001/api/health
```

`/api/health` 应返回包含 `"ok":true` 的 JSON，说明 Node 服务已正常启动。

## 6. 数据卷配置纠正过程

第一次启动时，Compose 使用了 Docker 命名卷。检查结果类似：

```text
volume /var/lib/docker/volumes/services_word-editor-data/_data -> /app/data
```

这与预期的宿主机目录 `/home/aiadmin/word-editor/data` 不一致。

由于当时 `/app/data` 为空，可以安全停止容器、修改配置并重新创建：

```bash
cd /home/aiadmin/word-editor/services
sudo docker compose down
```

将 Compose 挂载修正为：

```yaml
volumes:
  - /home/aiadmin/word-editor/data:/app/data:Z
```

确认宿主机目录存在：

```bash
mkdir -p /home/aiadmin/word-editor/data
```

重新检查并启动：

```bash
sudo docker compose config --quiet
sudo docker compose up -d --build
```

验证当前容器挂载：

```bash
sudo docker inspect word-editor \
  --format '{{range .Mounts}}{{println .Type .Source "->" .Destination}}{{end}}'
```

正确结果应类似：

```text
bind /home/aiadmin/word-editor/data -> /app/data
```

确认旧命名卷没有数据且不再被容器使用后，删除旧空卷：

```bash
sudo docker volume rm services_word-editor-data
```

验证旧卷已经删除：

```bash
sudo docker volume inspect services_word-editor-data
```

预期返回“no such volume”。如果旧卷中存在文件，不应直接删除，应先备份或迁移数据。

## 7. 域名和网络检查

内网域名解析结果：

```text
legaloffice.lenovo.com -> 10.195.6.81
```

Windows PowerShell 检查命令：

```powershell
Resolve-DnsName legaloffice.lenovo.com
```

部署 Nginx 前，服务器可以被 Ping 通，但 `443` 端口连接被拒绝。这说明 DNS 和基础网络正常，但服务器尚无 HTTPS 服务监听。

服务器监听端口检查：

```bash
sudo ss -lntup
```

当时 word-editor 仅监听：

```text
127.0.0.1:3001
```

这是预期配置，不能直接从其他电脑访问 `3001`，需要通过 Nginx 的 `443` 端口访问。

## 8. Nginx 和证书准备

服务器没有通过系统软件包安装 Nginx，但已经存在一份编译后的 Nginx：

```text
/home/aiadmin/nginx-1.27.2
```

Nginx 可执行文件：

```text
/home/aiadmin/nginx-1.27.2/objs/nginx
```

该文件权限仅允许 root 执行，因此相关命令使用 `sudo`。

检查编译参数：

```bash
sudo /home/aiadmin/nginx-1.27.2/objs/nginx -V 2>&1
```

HTTPS 配置要求输出中包含：

```text
--with-http_ssl_module
```

### 8.1 证书

已有的匹配证书和私钥位于：

```text
/home/aiadmin/only/tls.crt
/home/aiadmin/only/tls.key
```

证书包含域名：

```text
DNS:legaloffice.lenovo.com
```

证书有效期截止时间：

```text
2026-10-24 08:48:39 GMT
```

新建 Nginx 专用证书目录，不直接引用临时目录：

```bash
sudo install -d \
  -o root \
  -g root \
  -m 0755 \
  /home/aiadmin/nginx-1.27.2/conf/certs
```

复制证书和私钥：

```bash
sudo install \
  -o root -g root -m 0644 \
  /home/aiadmin/only/tls.crt \
  /home/aiadmin/nginx-1.27.2/conf/certs/legaloffice.crt

sudo install \
  -o root -g root -m 0600 \
  /home/aiadmin/only/tls.key \
  /home/aiadmin/nginx-1.27.2/conf/certs/legaloffice.key
```

私钥不能设置为 `644`、`666` 或 `777`，也不能输出或发送私钥内容。

### 8.2 验证证书和私钥匹配

分别计算公钥摘要：

```bash
sudo openssl x509 \
  -in /home/aiadmin/nginx-1.27.2/conf/certs/legaloffice.crt \
  -pubkey -noout |
openssl pkey -pubin -outform DER |
sha256sum
```

```bash
sudo openssl pkey \
  -in /home/aiadmin/nginx-1.27.2/conf/certs/legaloffice.key \
  -pubout -outform DER |
sha256sum
```

两个 SHA256 必须完全相同。

曾经直接以 `aiadmin` 读取证书时发生 `Permission denied`，管道后续计算出了：

```text
e3b0c44298fc1c149afbf4c8996fb924...
```

这是空输入的 SHA256，并不是有效的证书摘要。重新使用 `sudo openssl x509 ...` 后再比较结果。

`/home/aiadmin/tmp/tls.crt` 和 `/home/aiadmin/tmp/private.key` 的摘要不同，因此本次未使用 `tmp` 目录中的私钥。

## 9. Nginx 完整配置

配置文件：

```text
/home/aiadmin/nginx-1.27.2/conf/nginx.conf
```

部署前备份原配置：

```bash
sudo cp -a \
  /home/aiadmin/nginx-1.27.2/conf/nginx.conf \
  /home/aiadmin/nginx-1.27.2/conf/nginx.conf.bak-20260818
```

当前配置内容：

```nginx
worker_processes auto;

error_log logs/error.log;
pid       logs/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;

    sendfile on;
    keepalive_timeout 65;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    server {
        listen 80;
        server_name legaloffice.lenovo.com;

        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name legaloffice.lenovo.com;

        ssl_certificate     /home/aiadmin/nginx-1.27.2/conf/certs/legaloffice.crt;
        ssl_certificate_key /home/aiadmin/nginx-1.27.2/conf/certs/legaloffice.key;

        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        client_max_body_size 100m;

        location / {
            proxy_pass http://127.0.0.1:3001;
            proxy_http_version 1.1;

            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;

            proxy_connect_timeout 30s;
            proxy_read_timeout 300s;
            proxy_send_timeout 300s;

            proxy_buffering off;
        }
    }
}
```

## 10. Nginx 日志目录问题

第一次执行配置检查时出现：

```text
could not open error log file: .../logs/error.log: No such file or directory
open() ".../logs/nginx.pid" failed: No such file or directory
```

配置语法本身已经显示 `syntax is ok`，失败原因是编译目录中缺少运行时 `logs` 目录。

创建目录：

```bash
sudo install -d \
  -o root \
  -g root \
  -m 0755 \
  /home/aiadmin/nginx-1.27.2/logs
```

即使原始默认配置注释了 `error_log` 和 `pid`，Nginx 仍可能使用编译时默认的相对路径，因此该目录仍然需要存在。

## 11. 检查并启动 Nginx

检查配置：

```bash
sudo /home/aiadmin/nginx-1.27.2/objs/nginx \
  -p /home/aiadmin/nginx-1.27.2/ \
  -c conf/nginx.conf \
  -t
```

预期结果：

```text
syntax is ok
test is successful
```

启动 Nginx：

```bash
sudo /home/aiadmin/nginx-1.27.2/objs/nginx \
  -p /home/aiadmin/nginx-1.27.2/ \
  -c conf/nginx.conf
```

检查监听端口：

```bash
sudo ss -lntp | grep -E ':(80|443)\b'
```

配置修改后，先执行 `-t`，通过后再平滑重载：

```bash
sudo /home/aiadmin/nginx-1.27.2/objs/nginx \
  -p /home/aiadmin/nginx-1.27.2/ \
  -c conf/nginx.conf \
  -s reload
```

## 12. 最终验证

服务器本机验证 HTTP 跳转：

```bash
curl -I http://legaloffice.lenovo.com
```

预期返回 `301`，并跳转到 HTTPS。

验证 HTTPS 和反向代理：

```bash
curl -vk https://legaloffice.lenovo.com/
```

办公电脑 PowerShell 验证端口：

```powershell
Test-NetConnection legaloffice.lenovo.com -Port 443
```

预期结果：

```text
TcpTestSucceeded : True
```

最后通过浏览器访问：

```text
https://legaloffice.lenovo.com/
```

本次已确认浏览器可以正常打开 word-editor 页面。

## 13. 常用运维命令

### 13.1 word-editor

```bash
cd /home/aiadmin/word-editor/services

# 查看状态
sudo docker compose ps

# 查看日志
sudo docker compose logs -f --tail=100 word-editor

# 重新构建并启动
sudo docker compose up -d --build

# 重启
sudo docker compose restart word-editor

# 停止并移除容器和 Compose 网络，不删除 bind mount 数据
sudo docker compose down
```

不要随意执行 `docker compose down -v` 或删除 `/home/aiadmin/word-editor/data`。

### 13.2 Nginx

```bash
# 配置检查
sudo /home/aiadmin/nginx-1.27.2/objs/nginx \
  -p /home/aiadmin/nginx-1.27.2/ \
  -c conf/nginx.conf \
  -t

# 平滑重载
sudo /home/aiadmin/nginx-1.27.2/objs/nginx \
  -p /home/aiadmin/nginx-1.27.2/ \
  -c conf/nginx.conf \
  -s reload

# 查看错误日志
sudo tail -n 100 /home/aiadmin/nginx-1.27.2/logs/error.log
```

## 14. 后续待办

1. 为自编译 Nginx 创建 `systemd` 服务。本次 Nginx 是手工启动，服务器重启后不一定自动恢复；
2. 在 2026-10-24 前更新 `legaloffice.lenovo.com` 证书，并提前安排续期；
3. 定期备份 `/home/aiadmin/word-editor/data`，并实际验证恢复流程；
4. 增加容器、磁盘、Nginx、HTTP 健康检查和证书到期监控；
5. 限制测试服务的访问范围和编辑器文档权限；
6. 使用真实脱敏法律文档验证 DOCX 导入、编辑、保存、导出和重启后的数据持久化；
7. 在完成鉴权、租户隔离、LegalAI 正式回写和格式兼容性验证前，不替换现有 FileZ 生产链路；
8. 定期轮换 `TOKEN_SECRET`，轮换后验证重新打开合同、自动保存草稿和正式保存均正常。

## 15. 故障排查顺序

浏览器无法访问时，建议依次检查：

```text
1. Resolve-DnsName 是否仍解析到 10.195.6.81
2. Test-NetConnection 的 443 是否成功
3. Nginx 是否监听 80/443
4. Nginx 配置检查是否通过
5. Nginx error.log 是否有错误
6. curl http://127.0.0.1:3001/api/health 是否返回 `{"ok":true}`
7. word-editor 容器是否运行
8. docker compose logs 是否有应用错误
9. 容器挂载是否仍指向 /home/aiadmin/word-editor/data
```

对应命令：

```bash
sudo ss -lntp | grep -E ':(80|443|3001)\b'

sudo /home/aiadmin/nginx-1.27.2/objs/nginx \
  -p /home/aiadmin/nginx-1.27.2/ \
  -c conf/nginx.conf \
  -t

sudo tail -n 100 /home/aiadmin/nginx-1.27.2/logs/error.log
curl -fsS http://127.0.0.1:3001/api/health

cd /home/aiadmin/word-editor/services
sudo docker compose ps
sudo docker compose logs --tail=100 word-editor

sudo docker inspect word-editor \
  --format '{{range .Mounts}}{{println .Type .Source "->" .Destination}}{{end}}'
```
