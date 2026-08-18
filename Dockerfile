# The editor itself (public/js/*.js) stays zero-dependency vanilla JS. The
# Node server has a small set of server-only dependencies: jsdom (DOM shim so
# the client's own docx.js can be reused for server-side DOCX<->HTML
# conversion — see server/docxNode.mjs), redis (cross-instance collab sync —
# see server.js's initRedis()), and the system-level `soffice` binary
# (LibreOffice headless, for legacy .doc/.dot -> .docx conversion — see
# server/docConvert.js). All three are optional at runtime: without
# STORAGE_DRIVER=s3 / REDIS_URL / a working soffice, the server runs exactly
# as before, just without that one capability (.doc import degrades to a
# clear "please convert manually" error instead of a crash).
#
# Debian-based rather than Alpine specifically for LibreOffice: its headless
# conversion is the standard, well-tested combination most doc-processing
# services run in production; Alpine's musl libc has had reported
# reliability quirks with LibreOffice specifically.
FROM node:22-bookworm-slim

WORKDIR /app

# libreoffice-writer (not the full `libreoffice` metapackage) is enough for
# .doc/.dot -> .docx conversion and keeps the image meaningfully smaller.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY server ./server
COPY public ./public

# Persist documents inside the container when using the local storage driver
# (mount a named volume to keep them). Not used when STORAGE_DRIVER=s3.
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATA_DIR=/app/data

EXPOSE 3001

CMD ["node", "server.js"]
