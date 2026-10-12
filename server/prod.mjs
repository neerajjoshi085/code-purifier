/**
 * Production server: serves the built app (dist/) and the site-fetch API from one process.
 *
 *   npm run build && npm start          # PORT=8080 HOST=0.0.0.0 by default
 *
 * The app is a single-page app with path routes (/css, /js, /docs): those paths are answered
 * with index.html, and the app picks the page from the address.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/ not found — run "npm run build" first.');
  process.exit(1);
}

const api = createApiHandler();
const APP_ROUTES = new Set(['/css', '/js', '/docs']);

const server = http.createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    const { pathname } = new URL(req.url || '/', 'http://localhost');
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && APP_ROUTES.has(pathname.replace(/\/+$/, ''))) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.listen(port, host, () => console.log(`Code Purifier → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
