/**
 * Browser side of "enter a website address": asks the server to download the site's
 * public files (browsers can't read other sites directly) and turns the answer into the
 * same LoadedFile shape that uploaded files have. Analysis still happens locally.
 */

export class SiteFetchError extends Error {}

const NO_SERVER = 'Fetching a website isn’t available on this deployment. Upload the site’s files or paste the code instead.';

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {string} url
 * @param {{ maxPages?: number, signal?: AbortSignal, onProgress?: (p: { message: string, percent: number }) => void }} [options]
 * @returns {Promise<{ site: { url: string, host: string, origin: string, pages: number, bytes: number }, files: import('./fileReader.js').LoadedFile[], issues: import('./fileReader.js').LoadIssue[] }>}
 */
export async function fetchSiteFiles(url, { maxPages = 5, signal, onProgress } = {}) {
  let res;
  try {
    res = await fetch('/api/fetch-site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, maxPages }), signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new SiteFetchError('Couldn’t reach the Code Purifier server. Check your connection and try again.');
  }

  const type = res.headers.get('content-type') || '';
  if (!type.includes('ndjson')) {
    // Either a JSON error from the endpoint (rate limit, bad request…) or no endpoint at all (static hosting).
    const body = type.includes('json') ? await res.json().catch(() => null) : null;
    throw new SiteFetchError(body?.error?.message || NO_SERVER);
  }

  let result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.type === 'progress') onProgress?.(msg);
    else if (msg.type === 'result') result = msg;
    else if (msg.type === 'error') throw new SiteFetchError(msg.message);
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer);
  if (!result) throw new SiteFetchError('The connection ended before the site finished downloading. Please try again.');

  const files = result.files.map((f) =>
    f.text !== undefined ? { path: f.path, kind: f.kind, size: f.size, text: f.text } : { path: f.path, kind: f.kind, size: f.size, data: bytesFromBase64(f.base64) },
  );

  const issues = [];
  // Older servers only send { host, count }: treat those counts as scripts (the cautious reading).
  const tp = result.thirdParty.map((t) => ({ host: t.host, scripts: t.scripts ?? t.count, stylesheets: t.stylesheets ?? 0 }));
  const hostList = (list) => list.slice(0, 4).map((t) => t.host).join(', ') + (list.length > 4 ? '…' : '');
  const scriptHosts = tp.filter((t) => t.scripts > 0);
  if (scriptHosts.length) {
    const count = scriptHosts.reduce((n, t) => n + t.scripts, 0);
    issues.push({
      kind: 'third-party',
      file: null,
      severity: 'warning',
      message: `${plural(count, 'script', 'scripts')} hosted elsewhere (${hostList(scriptHosts)}) can’t be downloaded, so they weren’t analysed. Classes those scripts add to the page are invisible to the purifier, so test the purified site before you publish it.`,
    });
  }
  const styleHosts = tp.filter((t) => t.stylesheets > 0);
  if (styleHosts.length) {
    const count = styleHosts.reduce((n, t) => n + t.stylesheets, 0);
    issues.push({
      kind: 'third-party-css',
      file: null,
      severity: 'info',
      message: `${plural(count, 'stylesheet is', 'stylesheets are')} loaded from other websites (${hostList(styleHosts)}). They are left as they are: only this site’s own stylesheets are purified.`,
    });
  }
  const evidence = (result.evidence || []).map((e) => ({ path: e.path, text: e.text }));
  if (evidence.length) {
    const names = evidence.slice(0, 3).map((e) => e.path.split('/').pop());
    issues.push({
      kind: 'cdn-evidence',
      file: null,
      severity: 'info',
      message: `Also read ${plural(evidence.length, 'script', 'scripts')} the page loads from public CDNs (${names.join(', ')}${evidence.length > 3 ? '…' : ''}) to see which classes they add. They are not changed or included in downloads.`,
    });
  }
  for (const w of result.warnings.slice(0, 8)) issues.push({ kind: 'site', file: null, severity: 'warning', message: w });
  if (result.warnings.length > 8) issues.push({ kind: 'site', file: null, severity: 'warning', message: `…and ${result.warnings.length - 8} more problems while downloading.` });

  return { site: { url: result.url, host: result.host, origin: result.origin, pages: result.pages, bytes: result.bytes, evidence }, files, issues };
}
