/**
 * Vercel serverless function for POST /api/fetch-site — the same endpoint the Vite dev server
 * and server/prod.mjs mount (see server/api.js). Vercel serves the built app from dist/ and
 * runs this file for the API.
 *
 * - The response is streamed (one JSON line at a time), which Vercel does by default for Node.js
 *   functions; streamed responses are not subject to the 4.5 MB response-size limit, so large
 *   sites (images, fonts) still come through.
 * - The function may run 60 s (vercel.json, allowed on every plan); the site download has a 55 s
 *   deadline inside that,
 *   so a slow site ends with a clear error instead of the platform cutting the connection.
 */
import { createApiHandler } from '../server/api.js';

const handle = createApiHandler({ totalTimeoutMs: 55_000 });

export default async function handler(req, res) {
  const handled = await handle(req, res);
  if (!handled) {
    res.statusCode = 404;
    res.end('Not found');
  }
}
