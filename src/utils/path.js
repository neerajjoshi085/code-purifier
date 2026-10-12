/** POSIX-style virtual path helpers for the in-memory project. */

export function normalizePath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

/** Strip ?query and #hash from a URL-ish string. */
export function stripQueryHash(url) {
  const q = url.search(/[?#]/);
  return q === -1 ? url : url.slice(0, q);
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** True for http(s):, data:, mailto:, blob:, javascript:, protocol-relative, etc. */
export function isExternalUrl(url) {
  return EXTERNAL.test(url.trim());
}

/**
 * Resolve `ref` (as written in `fromPath`) to a normalized project path.
 * Root-relative refs ("/css/a.css") resolve from the project root.
 */
export function resolveRelative(fromPath, ref) {
  const clean = decodeUriSafe(stripQueryHash(ref.trim()));
  if (!clean) return null;
  if (clean.startsWith('/')) return normalizePath(clean.slice(1));
  return normalizePath(joinPath(dirname(fromPath), clean));
}

function decodeUriSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolves a reference against the project's file map. Falls back to a unique
 * basename match so loose multi-file uploads (no folder structure) still link up.
 * @param {Map<string, any>|Set<string>} files
 * @param {Map<string, string[]>} basenameIndex
 */
export function resolveInProject(files, basenameIndex, fromPath, ref, rootDir = '') {
  if (!ref || isExternalUrl(ref) || ref.startsWith('#')) return null;
  const exact = resolveRelative(fromPath, ref);
  if (exact && files.has(exact)) return exact;
  if (exact && rootDir && ref.trim().startsWith('/')) {
    const alt = joinPath(rootDir, exact);
    if (files.has(alt)) return alt;
  }
  if (exact) {
    // Try common extension-less module specifiers: ./util -> ./util.js
    for (const ext of ['.js', '.mjs', '.jsx', '/index.js', '/index.mjs', '/index.jsx']) {
      if (files.has(exact + ext)) return exact + ext;
    }
  }
  const base = basename(decodeUriSafe(stripQueryHash(ref)));
  const hits = basenameIndex.get(base);
  if (hits && hits.length === 1) return hits[0];
  return null;
}

export function buildBasenameIndex(paths) {
  const idx = new Map();
  for (const p of paths) {
    const b = basename(p);
    const arr = idx.get(b);
    if (arr) arr.push(p);
    else idx.set(b, [p]);
  }
  return idx;
}
