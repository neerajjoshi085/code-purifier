/**
 * Browser-only: turns File objects / dropped folders into project entries.
 * Everything is read locally with the File API — nothing leaves the machine.
 */
import { ACCEPTED_EXT, FILE_KIND, LIMITS } from '../utils/constants.js';
import { extname, normalizePath } from '../utils/path.js';
import { classifyPath, isSkippedPath } from './fileManager.js';
import { unzipInWorker } from '../workers/workerClient.js';

const MAX_ASSET_BYTES = 60 * 1024 * 1024;

/**
 * @typedef {{ file: File, path: string }} FileItem
 * @typedef {{ path: string, kind: string, size: number, text?: string, data?: Uint8Array }} LoadedFile
 * @typedef {{ kind: string, file: string|null, message: string, severity: 'error'|'warning' }} LoadIssue
 */

/** FileList (input / folder input) → items with their relative paths. */
export function itemsFromFileList(fileList) {
  return [...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** Resolves a drop event's DataTransfer, descending into dropped folders. */
export async function itemsFromDataTransfer(dt) {
  const items = [];
  const entries = [];
  if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
    for (const it of dt.items) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) await walkEntry(entry, '', items);
    return items;
  }
  return itemsFromFileList(dt.files);
}

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    if (isSkippedPath(prefix + entry.name)) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    } while (batch.length);
  }
}

/**
 * @param {FileItem[]} items
 * @returns {Promise<{ files: LoadedFile[], issues: LoadIssue[] }>}
 */
export async function readItems(items) {
  const files = [];
  const issues = [];
  for (const { file, path: rawPath } of items) {
    const path = normalizePath(rawPath);
    const ext = extname(file.name);
    try {
      if (ext === '.zip') {
        const buffer = await file.arrayBuffer();
        const res = await unzipInWorker(buffer);
        for (const w of res.warnings) issues.push({ kind: 'zip', file: file.name, message: w, severity: 'warning' });
        if (res.error) {
          issues.push({ kind: 'zip', file: file.name, message: res.error, severity: 'error' });
          continue;
        }
        for (const e of res.entries) files.push(toLoaded(e.path, e.data));
        continue;
      }
      if (isSkippedPath(path)) continue;
      const inFolder = path.includes('/');
      if (!inFolder && !ACCEPTED_EXT.includes(ext)) {
        issues.push({
          kind: 'unsupported',
          file: file.name,
          message: `Unsupported file type "${ext || file.name}". Supported: .html, .css, .js, .mjs, .jsx and .zip.`,
          severity: 'error',
        });
        continue;
      }
      const kind = classifyPath(path);
      if (kind === FILE_KIND.ASSET) {
        if (file.size > MAX_ASSET_BYTES) {
          issues.push({ kind: 'too-large', file: path, message: `"${path}" is larger than 60 MB and was skipped.`, severity: 'warning' });
          continue;
        }
        files.push({ path, kind, size: file.size, data: new Uint8Array(await file.arrayBuffer()) });
      } else {
        if (file.size > LIMITS.maxTextFileBytes) {
          issues.push({ kind: 'too-large', file: path, message: `"${path}" is larger than ${Math.round(LIMITS.maxTextFileBytes / 1048576)} MB and was skipped.`, severity: 'error' });
          continue;
        }
        let text = await file.text();
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        files.push({ path, kind, size: file.size, text });
      }
    } catch (err) {
      issues.push({ kind: 'read', file: file.name, message: `Could not read "${file.name}": ${err?.message || err}`, severity: 'error' });
    }
  }
  return { files, issues };
}

function toLoaded(path, data) {
  const kind = classifyPath(path);
  if (kind === FILE_KIND.ASSET) return { path, kind, size: data.byteLength, data };
  let text = new TextDecoder('utf-8').decode(data);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { path, kind, size: data.byteLength, text };
}
