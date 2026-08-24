"use strict";
// Local-directory storage used by the editor for document metadata, draft
// state, generated DOCX files, and version snapshots.
//
// The editor is not the business document system of record. LegalAI owns the
// formally committed document; DATA_DIR only provides the working storage
// required by the document library, autosave, and version-history features.

const fs = require("fs");
const path = require("path");

function createStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const resolveKey = (key) => path.join(dataDir, key);

  return {
    kind: "local",
    async readFile(key) {
      try {
        return fs.readFileSync(resolveKey(key));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async writeFile(key, buffer) {
      fs.writeFileSync(resolveKey(key), buffer);
    },
    async deleteFile(key) {
      try {
        fs.unlinkSync(resolveKey(key));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    async exists(key) {
      return fs.existsSync(resolveKey(key));
    },
    async listKeys(suffix) {
      return fs.readdirSync(dataDir).filter((file) => !suffix || file.endsWith(suffix));
    },
  };
}

module.exports = { createStorage };
