/**
 * Download/ZIP Manager (pure part): reading and writing ZIP archives with fflate.
 * Runs inside a Web Worker in the app (see workers/zip.worker.js) but has no
 * browser dependencies, so it is also unit-tested in Node.
 */
import { strToU8, unzipSync, zipSync } from 'fflate';
import { LIMITS } from '../utils/constants.js';
import { extname, normalizePath } from '../utils/path.js';
import { isSkippedPath } from './fileManager.js';

const ALREADY_COMPRESSED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.zip', '.gz', '.mp3', '.mp4', '.webm', '.ogg', '.pdf', '.br']);

/**
 * @param {Uint8Array} bytes
 * @returns {{ entries: { path: string, data: Uint8Array }[], warnings: string[], error: string|null }}
 */
export function readZip(bytes) {
  const warnings = [];
  let total = 0;
  let count = 0;
  let tooBig = false;
  let tooMany = false;
  let files;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        if (isSkippedPath(normalizePath(file.name))) return false;
        if (count + 1 > LIMITS.maxZipEntries) {
          tooMany = true;
          return false;
        }
        if (total + file.originalSize > LIMITS.maxZipBytes) {
          tooBig = true;
          return false;
        }
        total += file.originalSize;
        count++;
        return true;
      },
    });
  } catch (err) {
    return { entries: [], warnings, error: `Broken ZIP: ${friendlyZipError(err)}` };
  }
  if (tooMany) warnings.push(`The archive has more than ${LIMITS.maxZipEntries} files; the rest were ignored.`);
  if (tooBig) warnings.push('Some files were skipped because the archive is larger than the supported size.');
  const entries = [];
  for (const name of Object.keys(files)) {
    const path = normalizePath(name);
    if (path) entries.push({ path, data: files[name] });
  }
  if (!entries.length) return { entries, warnings, error: 'The ZIP archive does not contain any usable files.' };
  return { entries, warnings, error: null };
}

function friendlyZipError(err) {
  const m = String(err?.message || err);
  if (/invalid zip data|unexpected eof|invalid block|invalid length|invalid distance/i.test(m)) return 'the file is not a valid or complete ZIP archive.';
  if (/unknown compression type/i.test(m)) return 'it uses a compression method that is not supported.';
  return m;
}

/**
 * @param {{ path: string, data?: Uint8Array, text?: string }[]} entries
 * @returns {Uint8Array}
 */
export function writeZip(entries) {
  const tree = {};
  for (const e of entries) {
    const path = normalizePath(e.path);
    if (!path || path in tree) continue;
    const data = e.data ?? strToU8(e.text ?? '');
    tree[path] = [data, { level: ALREADY_COMPRESSED.has(extname(path)) ? 0 : 6 }];
  }
  return zipSync(tree);
}
