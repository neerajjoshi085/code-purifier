/**
 * Download Manager (pure part): decides WHAT to download for each button.
 * It returns descriptors; the browser layer (utils/download.js) turns them into files.
 *
 *   { kind: 'file', filename, mime, text }
 *   { kind: 'zip',  filename, entries: [{ path, text } | { path, data }] }
 */
import { FILE_KIND } from '../utils/constants.js';
import { basename } from '../utils/path.js';

const MIME = { css: 'text/css', js: 'text/javascript', html: 'text/html' };

/**
 * @param {'css'|'js'|'html'} lang
 * @param {{ files: Record<string, any> }} result
 */
export function describeLangDownload(lang, result) {
  const list = Object.values(result.files).filter((f) => f.kind === lang && !f.inline && !f.failed);
  if (!list.length) return null;
  if (list.length === 1) return { kind: 'file', filename: basename(list[0].path), mime: MIME[lang], text: list[0].final };
  return { kind: 'zip', filename: `purified-${lang}.zip`, entries: list.map((f) => ({ path: f.path, text: f.final })) };
}

/**
 * Purified text files — no assets. `kinds` limits which languages are included
 * (a CSS or JS page only offers its own language plus the HTML that carries it).
 */
export function describeTextZip(result, kinds = ['css', 'js', 'html'], filename = 'purified-code.zip') {
  const list = Object.values(result.files).filter((f) => !f.inline && !f.failed && kinds.includes(f.kind));
  return { kind: 'zip', filename, entries: list.map((f) => ({ path: f.path, text: f.final })) };
}

/**
 * The full website with purified CSS/JS/HTML and every other file untouched,
 * preserving the original folder structure. Only files of the given `kinds` take their
 * purified text; every other file ships exactly as it was uploaded.
 * @param {{ files: Map<string, any>|Record<string, any> }} project  original project files (path → {kind, data?, text?})
 */
export function describeWebsiteDownload(projectFiles, result, kinds = ['css', 'js', 'html']) {
  const entries = [];
  for (const f of projectFiles) {
    const r = result.files[f.path];
    if (f.kind === FILE_KIND.ASSET) {
      if (f.data) entries.push({ path: f.path, data: f.data });
    } else if (r && !r.failed && kinds.includes(f.kind)) entries.push({ path: f.path, text: r.final });
    else entries.push({ path: f.path, text: f.text });
  }
  return { kind: 'zip', filename: 'optimized-website.zip', entries };
}

export function describeSingleFile(filename, text, mime = 'text/plain') {
  return { kind: 'file', filename, mime, text };
}
