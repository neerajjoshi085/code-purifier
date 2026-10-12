/**
 * HTTP endpoint for the site fetcher, shared by the Vite dev/preview servers and the
 * production server (server/prod.mjs).
 *
 *   POST /api/fetch-site   { "url": "example.com", "maxPages": 5 }
 *   → application/x-ndjson, one JSON object per line:
 *       { "type": "progress", "message": "…", "percent": 42 }
 *       { "type": "result", …fetchSite() result… }      or      { "type": "error", "code": "…", "message": "…" }
 *
 * Private/internal addresses are refused unless ALLOW_PRIVATE_HOSTS=1 (handy for
 * purifying a site running on localhost; never enable it on a public deployment).
 */
import { SiteError, fetchSite } from './siteFetcher.js';

const MAX_BODY_BYTES = 4096;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12; // requests per client per window
const MAX_CONCURRENT = 8;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SiteError('bad-request', 'The request was too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Who is asking, for the rate limit. Behind Vercel every connection comes from its proxy, so the
 * visitor's address is taken from the header Vercel sets (and only there — elsewhere a client
 * could forge it).
 */
function clientOf(req) {
  if (process.env.VERCEL) {
    const ip = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) return String(ip);
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * @param {{ allowPrivate?: boolean, totalTimeoutMs?: number }} [options]
 *   totalTimeoutMs: overall deadline for one site download (keep it under the host's function limit)
 */
export function createApiHandler({ allowPrivate = process.env.ALLOW_PRIVATE_HOSTS === '1', totalTimeoutMs } = {}) {
  const hits = new Map(); // client → timestamps
  let active = 0;

  const rateLimited = (client) => {
    const now = Date.now();
    const recent = (hits.get(client) || []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    hits.set(client, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    return recent.length > RATE_MAX;
  };

  /** @returns {Promise<boolean>} true when the request was handled here */
  return async function handle(req, res) {
    const { pathname } = new URL(req.url || '/', 'http://localhost');
    if (pathname !== '/api/fetch-site') return false;

    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { error: { code: 'method', message: 'Use POST.' } });
      return true;
    }
    // Only our own page may call this: a JSON body forces a CORS preflight for other sites,
    // and the Origin check rejects any that get past it.
    const origin = req.headers.origin;
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')) || (origin && new URL(origin).host !== req.headers.host)) {
      sendJson(res, 403, { error: { code: 'forbidden', message: 'This endpoint can only be used from the Code Purifier page.' } });
      return true;
    }
    if (rateLimited(clientOf(req))) {
      sendJson(res, 429, { error: { code: 'rate-limit', message: 'Too many requests. Please wait a minute and try again.' } });
      return true;
    }
    if (active >= MAX_CONCURRENT) {
      sendJson(res, 503, { error: { code: 'busy', message: 'The fetcher is busy right now. Please try again in a moment.' } });
      return true;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: { code: 'bad-request', message: 'The request could not be read.' } });
      return true;
    }
    if (!payload || typeof payload.url !== 'string') {
      sendJson(res, 400, { error: { code: 'bad-url', message: 'Enter the address of a website, like example.com.' } });
      return true;
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const write = (obj) => {
      if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + '\n');
    };
    const controller = new AbortController();
    res.on('close', () => controller.abort()); // the user cancelled or left the page
    active++;
    try {
      const result = await fetchSite(payload.url, {
        maxPages: payload.maxPages,
        allowPrivate,
        totalTimeoutMs,
        signal: controller.signal,
        onProgress: (p) => write({ type: 'progress', ...p }),
      });
      write({ type: 'result', ...result });
    } catch (err) {
      if (!(err instanceof SiteError)) console.error('[site-fetcher]', err);
      write({ type: 'error', code: err instanceof SiteError ? err.code : 'internal', message: err instanceof SiteError ? err.message : 'Something went wrong while fetching that site.' });
    } finally {
      active--;
      res.end();
    }
    return true;
  };
}
