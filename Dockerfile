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

# Persist editor working data by mounting /app/data. LegalAI remains the
# system of record for formally committed business documents.
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATA_DIR=/app/data

EXPOSE 3001

CMD ["node", "server.js"]
