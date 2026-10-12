/**
 * Site fetcher — downloads a public website as a virtual project the purifier can analyse.
 *
 * Browsers cannot read other sites' files (CORS), so this is the one piece that runs on a
 * server. It only *downloads* public files; the analysis itself still happens in the
 * user's browser, and nothing fetched is stored.
 *
 *   fetchSite('example.com', { maxPages: 5 })
 *     → { files: [{ path, kind, url, size, text | base64 }], pages, thirdParty, evidence, warnings, … }
 *       (`evidence`: scripts from public CDNs, read only to see which classes they add)
 *
 * What is collected (same site only): the page, same-site pages linked from it (breadth
 * first, up to `maxPages`), their stylesheets (+ @import chains), scripts (+ static ES
 * module imports), and the images/fonts those reference. Every file is stored under a
 * path that mirrors its URL, so relative references keep resolving exactly as they did on
 * the live site; same-site *absolute* URLs are rewritten to root-relative ones so the
 * engine can link them up.
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Writable, pipeline } from 'node:stream';
import { parseHtml, walkElements } from '../src/parsers/htmlParser.js';
import { extname } from '../src/utils/path.js';
import { SiteError, assertUrlAllowed, pinnedLookup } from './netGuard.js';

export { SiteError };

export const LIMITS = Object.freeze({
  maxRedirects: 5,
  requestTimeoutMs: 12_000,
  totalTimeoutMs: 90_000,
  maxPageBytes: 5 * 1024 * 1024,
  maxScriptBytes: 8 * 1024 * 1024,
  maxAssetBytes: 4 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxFiles: 400,
  maxAssets: 150,
  maxPages: 30,
  maxImportDepth: 3,
  concurrency: 6,
  maxEvidenceScripts: 20,
  maxEvidenceBytes: 6 * 1024 * 1024,
});

/**
 * Public CDNs whose scripts are read for evidence only. A carousel or lightbox loaded from a CDN
 * adds classes the site's own CSS styles (`.owl-nav`, `.mfp-close`…); without reading it those
 * rules look unused. These files are never purified or offered for download.
 */
const EVIDENCE_CDN_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'code.jquery.com',
  'ajax.googleapis.com',
  'stackpath.bootstrapcdn.com',
  'maxcdn.bootstrapcdn.com',
  'cdn.datatables.net',
]);

const USER_AGENT = 'Mozilla/5.0 (compatible; CodePurifier/1.0; +site-snapshot) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const JS_EXTS = ['.js', '.mjs', '.cjs', '.jsx'];
const PAGE_EXTS = new Set(['.html', '.htm']);
const LINKABLE_PAGE_EXTS = new Set(['', '.html', '.htm', '.shtml', '.php', '.asp', '.aspx', '.jsp']);
const ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot']);

/* ------------------------------------------------------------------ input */

/** "example.com", "//example.com/a" or a full URL → URL. Throws SiteError for anything unusable. */
export function normalizeInputUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw || raw.length > 2048) throw new SiteError('bad-url', 'Enter the address of a website, like example.com.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SiteError('bad-url', 'That doesn’t look like a valid web address.');
  }
  url.hash = '';
  return url;
}

/* ------------------------------------------------------------------ HTTP */

const ERROR_TEXT = {
  ENOTFOUND: 'We couldn’t find that website. Check the address for typos.',
  EAI_AGAIN: 'We couldn’t look that website up right now. Try again in a moment.',
  ECONNREFUSED: 'The website refused the connection.',
  ECONNRESET: 'The connection to the website was interrupted.',
  EHOSTUNREACH: 'The website could not be reached.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The website’s security certificate isn’t trusted.',
  SELF_SIGNED_CERT_IN_CHAIN: 'The website’s security certificate isn’t trusted.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The website’s security certificate isn’t trusted.',
  CERT_HAS_EXPIRED: 'The website’s security certificate has expired.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'The website’s security certificate doesn’t match its address.',
};

function wrapError(err, signal) {
  if (err instanceof SiteError) return err;
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError' ? new SiteError('timeout', 'This took too long and was stopped. Try scanning fewer pages.') : new SiteError('aborted', 'Cancelled.');
  }
  if (err?.name === 'AbortError') return new SiteError('aborted', 'Cancelled.');
  return new SiteError('network', ERROR_TEXT[err?.code] || `The website could not be reached (${err?.code || err?.message || 'unknown error'}).`);
}

function requestOnce(url, { allowPrivate, signal, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: pinnedLookup(allowPrivate),
        signal,
        timeout: LIMITS.requestTimeoutMs,
        headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, deflate, br' },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return finish(resolve, { status, redirect: res.headers.location });
        }
        if (Number(res.headers['content-length']) > maxBytes) {
          res.destroy();
          return finish(reject, new SiteError('too-large', 'A file on that site is too large to fetch.'));
        }
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
        const decoder = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding];
        if (encoding && encoding !== 'identity' && !decoder) {
          res.destroy();
          return finish(reject, new SiteError('network', `The website used an unsupported encoding (${encoding}).`));
        }
        const chunks = [];
        let size = 0;
        const sink = new Writable({
          write(chunk, _enc, cb) {
            size += chunk.length;
            if (size > maxBytes) return cb(new SiteError('too-large', 'A file on that site is too large to fetch.'));
            chunks.push(chunk);
            return cb();
          },
        });
        pipeline(...[res, decoder && decoder(), sink].filter(Boolean), (err) => {
          if (err) finish(reject, wrapError(err, signal));
          else finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('timeout', () => req.destroy(new SiteError('timeout', 'The website took too long to respond.')));
    req.on('error', (err) => finish(reject, wrapError(err, signal)));
    req.end();
  });
}

/** GET with manual redirect handling — every hop is re-validated. */
async function fetchUrl(startUrl, opts) {
  let url = startUrl;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    assertUrlAllowed(url, opts.allowPrivate);
    const res = await requestOnce(url, opts);
    if (res.redirect) {
      try {
        url = new URL(res.redirect, url);
      } catch {
        throw new SiteError('network', 'The website sent an invalid redirect.');
      }
      url.hash = '';
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SiteError('http', `The website answered “${res.status} ${http.STATUS_CODES[res.status] || 'Error'}”.`);
    }
    return { ...res, url };
  }
  throw new SiteError('network', 'The website redirected too many times.');
}

function decodeText(buffer, contentType = '') {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] || /^@charset\s+["']([\w-]+)["']/i.exec(head)?.[1];
  }
  let text;
  try {
    text = new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    text = buffer.toString('utf8');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/* ------------------------------------------------------------------ URL ↔ project path */

const siteKey = (host) => host.toLowerCase().replace(/^www\./, '');
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function tryUrl(ref, base) {
  try {
    const u = new URL(ref.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** Where a URL lives in the virtual project, or null if it should not be mirrored. */
function pathFor(url, kind) {
  const pathname = safeDecode(url.pathname);
  const trailing = pathname.endsWith('/');
  let path = pathname.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  if (kind === 'page') {
    if (!path) path = 'index.html';
    else if (trailing) path += '/index.html';
    else if (!PAGE_EXTS.has(extname(path))) path += '.html';
  } else if (kind === 'css') {
    if (extname(path) !== '.css') path += '.css';
  } else if (kind === 'js') {
    if (!JS_EXTS.includes(extname(path))) path += '.js';
  } else if (!ASSET_EXTS.has(extname(path))) {
    return null;
  }
  return path && path.length <= 300 ? path : null;
}

const rootRelative = (path) => '/' + path.split('/').map(encodeURIComponent).join('/');
const isAbsoluteRef = (raw) => /^(?:https?:)?\/\//i.test(raw.trim());

function pageKey(url) {
  return `${siteKey(url.hostname)}${url.port ? ':' + url.port : ''}${url.pathname.replace(/\/+$/, '') || '/'}`;
}

/* ------------------------------------------------------------------ HTML analysis */

/** End offset (inclusive) of the start tag at `from`, honouring quoted attribute values. */
function startTagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return text.length - 1;
}

function parseSrcset(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.search(/\s/);
      return i === -1 ? { url: part, descriptor: '' } : { url: part.slice(0, i), descriptor: part.slice(i).trim() };
    });
}

/**
 * Finds everything a page references, plus the edits that make same-site absolute URLs root-relative.
 * @returns {{ refs: {url: URL, kind: string}[], links: URL[], rewrite: (map: (url: URL, kind: string) => string|null) => string }}
 */
function analyzePage(html, pageUrl) {
  const { document } = parseHtml(html);
  const entries = []; // { el, attr, kind, srcset }
  const links = [];
  if (document) {
    walkElements(document, (el) => {
      const a = el.attribs || {};
      const add = (attr, kind, srcset = false) => {
        if (a[attr]) entries.push({ el, attr, kind, srcset });
      };
      switch (el.name) {
        case 'link': {
          const rel = (a.rel || '').toLowerCase().split(/\s+/);
          if (rel.includes('stylesheet') || (rel.includes('preload') && a.as === 'style')) add('href', 'css');
          else if (rel.some((r) => r === 'icon' || r === 'shortcut' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed' || r === 'mask-icon') || (rel.includes('preload') && (a.as === 'font' || a.as === 'image'))) add('href', 'asset');
          break;
        }
        case 'script':
          add('src', 'js');
          break;
        case 'img':
          add('src', 'asset');
          add('srcset', 'asset', true);
          break;
        case 'source':
          add('srcset', 'asset', true);
          if (el.parent?.name === 'picture') add('src', 'asset');
          break;
        case 'video':
          add('poster', 'asset');
          break;
        case 'input':
          if (a.type === 'image') add('src', 'asset');
          break;
        case 'a': {
          const u = a.href && !('download' in a) ? tryUrl(a.href, pageUrl) : null;
          if (u) links.push(u);
          break;
        }
        default:
          break;
      }
    });
  }

  const refs = [];
  for (const e of entries) {
    const raw = e.el.attribs[e.attr];
    const urls = e.srcset ? parseSrcset(raw).map((c) => c.url) : [raw];
    for (const r of urls) {
      const url = tryUrl(r, pageUrl);
      if (url) refs.push({ url, kind: e.kind });
    }
  }

  function rewrite(mapRef) {
    const edits = [];
    for (const e of entries) {
      const raw = e.el.attribs[e.attr];
      const fix = (ref) => {
        const url = tryUrl(ref, pageUrl);
        return url ? mapRef(url, e.kind, ref) : null;
      };
      let next = null;
      if (e.srcset) {
        let changed = false;
        const parts = parseSrcset(raw).map((c) => {
          const n = fix(c.url);
          if (n === null) return `${c.url} ${c.descriptor}`.trim();
          changed = true;
          return `${n} ${c.descriptor}`.trim();
        });
        if (changed) next = parts.join(', ');
      } else {
        next = fix(raw);
      }
      if (next !== null && typeof e.el.startIndex === 'number') edits.push({ start: e.el.startIndex, attr: e.attr, value: next });
    }
    // Apply from the end of the document backwards so earlier offsets stay valid.
    edits.sort((a, b) => b.start - a.start);
    let out = html;
    for (const ed of edits) {
      const end = startTagEnd(out, ed.start);
      const tag = out.slice(ed.start, end + 1);
      const re = new RegExp(`(\\s${ed.attr}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i');
      if (!re.test(tag)) continue;
      out = out.slice(0, ed.start) + tag.replace(re, (_m, lead) => `${lead}"${escapeAttr(ed.value)}"`) + out.slice(end + 1);
    }
    return out;
  }
  return { refs, links, rewrite };
}

/* ------------------------------------------------------------------ CSS / JS scanning */

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/gi;
const JS_IMPORT_RE = /(?:^|[;{}\n])\s*(?:import|export)\s*(?:[\w*${}\s,]+?\s*from\s*)?(['"])(\.{0,2}\/[^'"\n]+)\1/g;

function* matches(re, text, group) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) yield { value: m[group] };
}

/** Rewrites same-site absolute URLs inside CSS (url(...) and @import "...") to root-relative ones. */
function rewriteCss(text, cssUrl, mapRef) {
  const swap = (ref, kind) => {
    if (!isAbsoluteRef(ref)) return null;
    const url = tryUrl(ref, cssUrl);
    return url ? mapRef(url, kind, ref) : null;
  };
  return text
    .replace(CSS_IMPORT_RE, (whole, q, ref) => {
      const n = swap(ref, 'css');
      return n === null ? whole : whole.replace(ref, n);
    })
    .replace(CSS_URL_RE, (whole, q, ref) => {
      if (/^(data|blob|about):/i.test(ref)) return whole;
      const n = swap(ref, 'asset');
      return n === null ? whole : `url("${n}")`;
    });
}

/* ------------------------------------------------------------------ the crawl */

async function pool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * @param {string} input address typed by the user
 * @param {{ maxPages?: number, allowPrivate?: boolean, signal?: AbortSignal, onProgress?: (p: {message: string, percent: number}) => void, totalTimeoutMs?: number }} [options]
 *   totalTimeoutMs: overall deadline (serverless hosts stop functions after a fixed time)
 */
export async function fetchSite(input, { maxPages = 1, allowPrivate = false, signal, onProgress = () => {}, totalTimeoutMs = LIMITS.totalTimeoutMs } = {}) {
  const entryInput = normalizeInputUrl(input);
  maxPages = Math.min(LIMITS.maxPages, Math.max(1, Math.floor(Number(maxPages)) || 1));
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const get = (url, maxBytes, accept) => fetchUrl(url, { allowPrivate, signal: sig, maxBytes, accept });

  const files = new Map(); // path → file
  const warnings = [];
  const thirdParty = new Map(); // host → { count, scripts, stylesheets }
  let totalBytes = 0;
  let budgetHits = 0;

  /* ---- entry page ---- */
  onProgress({ message: `Contacting ${entryInput.hostname}…`, percent: 4 });
  const first = await get(entryInput, LIMITS.maxPageBytes, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  if (!/html/i.test(String(first.headers['content-type'] || ''))) {
    throw new SiteError('not-html', 'That address didn’t return a web page. Enter the address of a page, like example.com.');
  }
  const site = { key: siteKey(first.url.hostname), port: first.url.port, origin: first.url.origin, host: first.url.hostname };
  const sameSite = (u) => siteKey(u.hostname) === site.key && u.port === site.port;
  const mapRef = (url, kind, raw) => {
    if (!sameSite(url)) return null;
    const path = pathFor(url, kind);
    if (!path) return null;
    // Rewrite absolute refs (so the engine can link them) and refs whose file name had to be completed.
    return isAbsoluteRef(raw) || safeDecode(url.pathname).replace(/^\//, '') !== path ? rootRelative(path) : null;
  };

  const store = (path, kind, url, body, text) => {
    files.set(path, { path, kind, url: String(url), size: body.length, ...(text !== undefined ? { text } : { base64: body.toString('base64') }) });
    totalBytes += body.length;
  };
  const overBudget = (extra = 0) => files.size >= LIMITS.maxFiles || totalBytes + extra > LIMITS.maxTotalBytes;

  /* ---- pages (breadth first) ---- */
  const pages = [];
  const seenPages = new Set();
  const refsByPage = [];
  const addPage = (res, url) => {
    const html = decodeText(res.body, res.headers['content-type']);
    const analysis = analyzePage(html, url);
    const path = pathFor(url, 'page') || 'index.html';
    const rewritten = analysis.rewrite(mapRef);
    store(path, 'html', url, Buffer.from(rewritten), rewritten);
    pages.push({ url, path });
    refsByPage.push(analysis);
    return analysis;
  };
  seenPages.add(pageKey(first.url));
  let frontier = [addPage(first, first.url)];
  while (pages.length < maxPages && frontier.length) {
    const candidates = [];
    for (const analysis of frontier) {
      for (const link of analysis.links) {
        if (!sameSite(link) || link.search || !LINKABLE_PAGE_EXTS.has(extname(link.pathname).toLowerCase())) continue;
        const key = pageKey(link);
        if (seenPages.has(key)) continue;
        seenPages.add(key);
        candidates.push(link);
      }
    }
    const wanted = candidates.slice(0, maxPages - pages.length);
    const found = [];
    let done = 0;
    await pool(wanted, 4, async (link) => {
      try {
        const res = await get(link, LIMITS.maxPageBytes, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
        if (!/html/i.test(String(res.headers['content-type'] || ''))) throw new SiteError('not-html', 'not a web page');
        if (!sameSite(res.url)) throw new SiteError('off-site', 'it redirects to another website');
        if (!pathFor(res.url, 'page') || files.has(pathFor(res.url, 'page'))) return;
        found.push({ res, url: res.url, order: wanted.indexOf(link) });
      } catch (err) {
        if (err.code === 'aborted' || err.code === 'timeout') throw err;
        warnings.push(`Skipped ${link.pathname}: ${err.message}`);
      } finally {
        onProgress({ message: `Reading pages (${Math.min(pages.length + ++done, maxPages)} of ${maxPages})…`, percent: 8 + Math.round((done / Math.max(1, wanted.length)) * 22) });
      }
    });
    frontier = found.sort((a, b) => a.order - b.order).map((f) => addPage(f.res, f.url));
  }

  /* ---- stylesheets, scripts, assets ---- */
  const jobs = new Map(); // path → { url, kind, depth }
  const deferredAssets = new Map();
  const evidenceJobs = new Map(); // url → URL (third-party scripts read for evidence only)
  const countThirdParty = (url, kind) => {
    const t = thirdParty.get(url.hostname) || { count: 0, scripts: 0, stylesheets: 0 };
    t.count++;
    if (kind === 'js') t.scripts++;
    else if (kind === 'css') t.stylesheets++;
    thirdParty.set(url.hostname, t);
  };
  const queueJob = (url, kind, depth) => {
    if (!sameSite(url)) {
      if (kind === 'js' && url.protocol === 'https:' && EVIDENCE_CDN_HOSTS.has(url.hostname.toLowerCase()) && evidenceJobs.size < LIMITS.maxEvidenceScripts) {
        evidenceJobs.set(url.href, url);
      } else if (kind !== 'asset') countThirdParty(url, kind);
      return null;
    }
    const path = pathFor(url, kind);
    if (!path || files.has(path)) return null;
    if (kind === 'asset') {
      if (!deferredAssets.has(path)) deferredAssets.set(path, { url, kind, depth });
      return null;
    }
    if (jobs.has(path)) return null;
    const job = { path, url, kind, depth };
    jobs.set(path, job);
    return job;
  };
  let round = [];
  for (const a of refsByPage) for (const r of a.refs) {
    const job = queueJob(r.url, r.kind, 0);
    if (job) round.push(job);
  }
  let fetched = 0;
  const totalCode = () => Math.max(1, jobs.size);
  while (round.length) {
    const next = [];
    await pool(round, LIMITS.concurrency, async (job) => {
      if (overBudget()) return void budgetHits++;
      try {
        const res = await get(job.url, LIMITS.maxScriptBytes, job.kind === 'css' ? 'text/css,*/*;q=0.1' : '*/*');
        let text = decodeText(res.body, res.headers['content-type']);
        if (job.kind === 'css') {
          for (const m of matches(CSS_IMPORT_RE, text, 2)) {
            const u = tryUrl(m.value, res.url);
            const child = u && queueJob(u, 'css', job.depth + 1);
            if (child && child.depth <= LIMITS.maxImportDepth) next.push(child);
          }
          for (const m of matches(CSS_URL_RE, text, 2)) {
            if (/^(data|blob|about):/i.test(m.value)) continue;
            const u = tryUrl(m.value, res.url);
            if (u) queueJob(u, 'asset', job.depth);
          }
          text = rewriteCss(text, res.url, mapRef);
        } else {
          for (const m of matches(JS_IMPORT_RE, text, 2)) {
            const u = tryUrl(m.value, res.url);
            const child = u && queueJob(u, 'js', job.depth + 1);
            if (child && child.depth <= LIMITS.maxImportDepth) next.push(child);
          }
        }
        store(job.path, job.kind, res.url, Buffer.from(text), text);
      } catch (err) {
        if (err.code === 'aborted' || err.code === 'timeout') throw err;
        warnings.push(`Could not download ${job.url.pathname}: ${err.message}`);
      } finally {
        fetched++;
        onProgress({ message: `Downloading stylesheets and scripts (${fetched} of ${totalCode()})…`, percent: 32 + Math.round((fetched / totalCode()) * 38) });
      }
    });
    round = next;
  }

  /* ---- third-party CDN scripts: read-only evidence ---- */
  const evidence = [];
  let evidenceBytes = 0;
  await pool([...evidenceJobs.values()], LIMITS.concurrency, async (url) => {
    try {
      const res = await get(url, LIMITS.maxScriptBytes, '*/*');
      if (evidenceBytes + res.body.length > LIMITS.maxEvidenceBytes) return void countThirdParty(url, 'js');
      evidenceBytes += res.body.length;
      evidence.push({ path: `${url.hostname}${safeDecode(url.pathname)}`, url: url.href, size: res.body.length, text: decodeText(res.body, res.headers['content-type']) });
    } catch (err) {
      if (err.code === 'aborted' || err.code === 'timeout') throw err;
      countThirdParty(url, 'js');
    }
  });
  evidence.sort((a, b) => a.path.localeCompare(b.path));

  let assetsDone = 0;
  const assetList = [...deferredAssets.entries()];
  if (assetList.length > LIMITS.maxAssets) budgetHits += assetList.length - LIMITS.maxAssets;
  await pool(assetList.slice(0, LIMITS.maxAssets), LIMITS.concurrency, async ([path, job]) => {
    try {
      if (!overBudget() && !files.has(path)) {
        const res = await get(job.url, LIMITS.maxAssetBytes, 'image/*,font/*,*/*;q=0.1');
        if (overBudget(res.body.length)) budgetHits++;
        else store(path, 'asset', res.url, res.body);
      } else if (!files.has(path)) budgetHits++;
    } catch (err) {
      if (err.code === 'aborted' || err.code === 'timeout') throw err;
      // a missing image or font should never fail the whole fetch
    } finally {
      onProgress({ message: `Downloading images and fonts (${++assetsDone} of ${assetList.length})…`, percent: 70 + Math.round((assetsDone / Math.max(1, assetList.length)) * 25) });
    }
  });

  if (budgetHits) warnings.push(`${budgetHits} file${budgetHits === 1 ? ' was' : 's were'} left out because the site is larger than the fetch limit.`);

  const order = { html: 0, css: 1, js: 2, asset: 3 };
  return {
    url: first.url.href,
    origin: site.origin,
    host: site.host,
    pages: pages.length,
    files: [...files.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path)),
    thirdParty: [...thirdParty.entries()].map(([host, t]) => ({ host, ...t })).sort((a, b) => b.count - a.count),
    evidence,
    warnings,
    bytes: totalBytes,
  };
}
