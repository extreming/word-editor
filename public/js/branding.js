// Product storage uses doc-editor; preserve values from previous namespaces.
export function migratePreferences(storage) {
  for (const suffix of ['locale', 'user', 'current-id', 'fullscreen-test:last-document-id']) {
    const key = `doc-editor:${suffix}`;
    try {
      if (storage.getItem(key) !== null) continue;
      for (const prefix of ['docflow', 'word-editor']) {
        const previous = storage.getItem(`${prefix}:${suffix}`);
        if (previous !== null) {
          storage.setItem(key, previous);
          break;
        }
      }
    } catch { /* Storage can be unavailable or full; editing must still work. */ }
  }
}

// Keep the physical key database: renaming it would create a new PDF signing
// identity. It is a storage compatibility identifier, not a product label.
export const PDF_KEY_DATABASE = 'word-editor-pdf';

try { migratePreferences(localStorage); } catch {}
