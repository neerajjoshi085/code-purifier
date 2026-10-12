/**
 * Browser-only: gives preview documents URLs for binary project files.
 * Fonts become data: URLs (font loads are CORS-checked, which blob: URLs from another
 * origin cannot satisfy inside a sandboxed iframe); everything else becomes a blob: URL.
 */
import { extname } from '../utils/path.js';

const FONT_EXT = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

function toBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** @param {Map<string, { data?: Uint8Array }>} files */
export function createAssetUrls(files) {
  const cache = new Map();
  const blobUrls = [];
  return {
    assetUrl(path) {
      if (cache.has(path)) return cache.get(path);
      const f = files.get(path);
      let url = null;
      if (f && f.data) {
        const ext = extname(path);
        const type = MIME[ext] || 'application/octet-stream';
        if (FONT_EXT.has(ext)) url = `data:${type};base64,${toBase64(f.data)}`;
        else {
          url = URL.createObjectURL(new Blob([f.data], { type }));
          blobUrls.push(url);
        }
      }
      cache.set(path, url);
      return url;
    },
    dispose() {
      for (const u of blobUrls) URL.revokeObjectURL(u);
      blobUrls.length = 0;
      cache.clear();
    },
  };
}
