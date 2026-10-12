/**
 * Project / File Manager — the in-memory virtual file system the engine analyses.
 * Pure data: no DOM, no React. Browser-only readers live in fileReader.js.
 */
import { CSS_EXT, FILE_KIND, HTML_EXT, JS_EXT, SKIPPED_FILE_NAMES, SKIPPED_PATH_PARTS } from '../utils/constants.js';
import { basename, buildBasenameIndex, extname, normalizePath } from '../utils/path.js';
import { byteLength } from '../utils/text.js';

export function classifyPath(path) {
  const ext = extname(path);
  if (HTML_EXT.includes(ext)) return FILE_KIND.HTML;
  if (CSS_EXT.includes(ext)) return FILE_KIND.CSS;
  if (JS_EXT.includes(ext)) return FILE_KIND.JS;
  return FILE_KIND.ASSET;
}

export function isSkippedPath(path) {
  const p = path + '/';
  if (SKIPPED_PATH_PARTS.some((part) => p.includes(part) || p.startsWith(part))) return true;
  return SKIPPED_FILE_NAMES.includes(basename(path));
}

function decode(data) {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * @typedef {{ path: string, text?: string, data?: Uint8Array }} FileEntry
 * @typedef {{ path: string, kind: 'html'|'css'|'js'|'asset', text?: string, data?: Uint8Array, size: number }} ProjectFile
 */

/**
 * @param {FileEntry[]} entries
 * @returns {{ files: Map<string, ProjectFile>, warnings: string[], rootDir: string, basenameIndex: Map<string,string[]> }}
 */
export function createProject(entries) {
  const files = new Map();
  const warnings = [];
  let skipped = 0;
  for (const e of entries) {
    const path = normalizePath(e.path);
    if (!path) continue;
    if (isSkippedPath(path)) {
      skipped++;
      continue;
    }
    const kind = classifyPath(path);
    if (files.has(path)) warnings.push(`Duplicate file "${path}" — the later one was used.`);
    if (kind === FILE_KIND.ASSET) {
      // Assets are only needed by the analysis for their existence/size; `data` may be omitted.
      const data = e.data ?? (e.text !== undefined ? new TextEncoder().encode(e.text) : undefined);
      files.set(path, { path, kind, data, size: e.size ?? data?.byteLength ?? 0 });
    } else {
      const text = e.text ?? (e.data ? decode(e.data) : '');
      files.set(path, { path, kind, text, size: e.data ? e.data.byteLength : byteLength(text) });
    }
  }
  if (skipped) warnings.push(`Ignored ${skipped} file${skipped === 1 ? '' : 's'} in node_modules, .git, __MACOSX and similar folders.`);
  return { files, warnings, rootDir: detectRootDir(files), basenameIndex: buildBasenameIndex(files.keys()) };
}

/** If the whole archive lives inside one wrapper folder (site/…), that folder acts as the web root. */
function detectRootDir(files) {
  const htmlPaths = [...files.values()].filter((f) => f.kind === FILE_KIND.HTML).map((f) => f.path);
  const all = [...files.keys()];
  if (!all.length) return '';
  const first = all[0].split('/');
  if (first.length < 2) return '';
  const top = first[0];
  if (all.every((p) => p.startsWith(top + '/'))) {
    // descend while still a single folder
    let prefix = top;
    for (;;) {
      const sub = all.map((p) => p.slice(prefix.length + 1).split('/'));
      if (sub.every((s) => s.length > 1) && new Set(sub.map((s) => s[0])).size === 1) prefix += '/' + sub[0][0];
      else break;
    }
    return prefix;
  }
  void htmlPaths;
  return '';
}

export function filesOfKind(project, kind) {
  return [...project.files.values()].filter((f) => f.kind === kind);
}

/** Total size in bytes by kind. */
export function sizeByKind(project) {
  const out = { html: 0, css: 0, js: 0, asset: 0 };
  for (const f of project.files.values()) out[f.kind] += f.size;
  return out;
}
