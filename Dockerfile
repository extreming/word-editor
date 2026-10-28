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


# The delivery ZIP contains this Dockerfile and doc-editor-source.tar.
COPY doc-editor-source.tar /tmp/doc-editor-source.tar
RUN tar -xf /tmp/doc-editor-source.tar -C /app \
    && rm /tmp/doc-editor-source.tar \
    && npm ci --omit=dev

ENV HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/app/data

EXPOSE 3001

CMD ["node", "server.js"]
