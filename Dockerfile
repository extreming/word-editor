# The editor itself (public/js/*.js) stays zero-dependency vanilla JS. The
# Node server depends on jsdom so the client's own docx.js can be reused for
# server-side DOCX<->HTML conversion (see server/docxNode.mjs). A system-level
# `soffice` binary is optional; without it, legacy .doc/.dot import returns a
# clear error while .docx editing continues to work.
#
# Debian-based rather than Alpine specifically for LibreOffice: its headless
# conversion is the standard, well-tested combination most doc-processing
# services run in production; Alpine's musl libc has had reported
# reliability quirks with LibreOffice specifically.
FROM node:22-bookworm-slim

WORKDIR /app


COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY server ./server
COPY public ./public

# 运维在构建前修改配置；修改后重新 build 并重建容器。
# TOKEN_SECRET 与业务系统签发 editor token 时使用的密钥一致。
ENV TOKEN_SECRET=a03de03549caabcae672b5f15af1788205fe6d4d60aae541daa860da84996bee \
    BUSINESS_API_BASE_URL=https//legalai-backend:8080 \
    BUSINESS_DOCUMENT_CONTENT_PATH=/doc-editor/legalai/content \
    BUSINESS_TOKEN_HEADER=token

# 工作文件保存在容器内，由应用自动创建目录，不需要宿主机目录或数据卷。
# 启动时不主动清空草稿；删除并重建容器会丢失工作文件。
ENV HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/app/data \
    BUSINESS_REQUEST_TIMEOUT_MS=30000 \
    BUSINESS_AUTO_COMMIT_ENABLED=false \
    BUSINESS_AUTO_COMMIT_INTERVAL_MS=300000 \
    VERSION_HISTORY_ENABLED=false \
    STARTUP_DRAFT_PURGE_ENABLED=false \
    DATA_RETENTION_HOURS=24 \
    DATA_CLEANUP_INTERVAL_MS=86400000 \
    DISK_CHECK_INTERVAL_MS=300000 \
    DISK_WARNING_PERCENT=70 \
    DISK_CRITICAL_PERCENT=85

EXPOSE 3001

CMD ["node", "server.js"]
