/**
 * ZIP worker — unzip / zip without blocking the UI.
 *   { type: 'unzip', id, buffer }   → { id, entries: [{path, data}], warnings, error }
 *   { type: 'zip',   id, entries }  → { id, buffer }
 */
import { readZip, writeZip } from '../project/zipManager.js';

self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'unzip') {
      const { entries, warnings, error } = readZip(new Uint8Array(msg.buffer));
      // Stored (uncompressed) entries can be views into one shared buffer; give each its own.
      const transfer = [];
      for (const e of entries) {
        const d = e.data;
        if (!(d.byteOffset === 0 && d.byteLength === d.buffer.byteLength)) e.data = d.slice();
        transfer.push(e.data.buffer);
      }
      self.postMessage({ id: msg.id, entries, warnings, error }, transfer);
    } else if (msg.type === 'zip') {
      const bytes = writeZip(msg.entries);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      self.postMessage({ id: msg.id, buffer }, [buffer]);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err?.message || err), entries: [], warnings: [] });
  }
};
