/**
 * Preview builder (pure, no DOM): turns one HTML page of the project into a
 * self-contained document that runs correctly inside a sandboxed <iframe srcdoc>.
 *
 *   - <link rel=stylesheet> and <script src> are inlined (url() / imports rewritten)
 *   - images, media and fonts are rewritten to blob:/data: URLs supplied by `assetUrl`
 *   - ES module graphs are bundled into nested data: URLs (cycles are reported)
 *   - a tiny diagnostics script reports console output, runtime errors and failed
 *     resource loads to the parent window
 *
 * The same builder renders the ORIGINAL and the PURIFIED project, so the two
 * previews differ only by what the purifier removed.
 */
import { parseHtml, walkElements } from '../parsers/htmlParser.js';
import { parseCss, walk } from '../parsers/cssParser.js';
import { parseJs } from '../parsers/jsParser.js';
import { applyEdits } from '../utils/edits.js';
import { buildBasenameIndex, isExternalUrl, resolveInProject } from '../utils/path.js';

const MAX_DEPTH = 40;

/** Replaces project-local URLs that do not exist, so the frame never falls back to the app's own origin. */
const INERT = 'data:,';

const CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline' data: blob:; font-src data: blob:; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'none'; frame-src data: blob:; form-action 'none'";

function diagnosticsScript(id) {
  return `(function(){var id=${JSON.stringify(id)};function s(t,d){try{parent.postMessage(Object.assign({__cp:id,type:t},d),'*')}catch(e){}}function str(v){try{if(v instanceof Error)return v.stack||String(v);if(typeof v==='object')return JSON.stringify(v);return String(v)}catch(e){return String(v)}}['error','warn','log','info'].forEach(function(l){var o=console[l];console[l]=function(){s('console',{level:l,text:[].map.call(arguments,str).join(' ').slice(0,2000)});return o.apply(console,arguments)}});window.addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){s('resource',{tag:t.tagName,url:String((t.getAttribute&&t.getAttribute('data-cp-missing'))||t.src||t.href).slice(0,300)})}else{s('error',{message:e.message,source:e.filename,line:e.lineno,col:e.colno})}},true);window.addEventListener('unhandledrejection',function(e){s('error',{message:'Unhandled promise rejection: '+str(e.reason)})});window.addEventListener('load',function(){s('load',{})});})();`;
}

/** End offset (inclusive) of the start tag beginning at `from`, honouring quoted attribute values. */
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

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escapeScript = (code) => code.replace(/<\/(script)/gi, '<\\/$1');
const escapeStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

function rebuildTag(el, overrides) {
  const attrs = { ...el.attribs, ...overrides };
  const parts = [`<${el.name}`];
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === null || v === undefined) continue;
    parts.push(v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`);
  }
  return parts.join('') + '>';
}

/**
 * @param {{
 *   htmlPath: string,
 *   files: Map<string, { kind: string, text?: string }>,
 *   textOf: (path: string) => string|undefined,       // the file content for this variant (original or purified)
 *   assetUrl: (path: string) => string|null,           // blob:/data: URL for a binary/other file, or null
 *   previewId: string,
 *   blockNetwork?: boolean,
 *   rootDir?: string,
 * }} input
 */
export function buildPreviewDoc({ htmlPath, files, textOf, assetUrl, previewId, blockNetwork = false, rootDir = '' }) {
  const basenameIndex = buildBasenameIndex(files.keys());
  const warnings = [];
  const missing = [];
  const resolve = (from, ref) => resolveInProject(files, basenameIndex, from, ref, rootDir);
  const html = textOf(htmlPath) ?? '';
  const { document } = parseHtml(html, { lowerCaseAttributeNames: false });
  if (!document) return { html: `<pre>Could not parse ${htmlPath}</pre>`, warnings: ['The page could not be parsed.'], missing };

  const noteMissing = (ref, from, kind) => {
    if (!missing.some((m) => m.ref === ref && m.from === from)) missing.push({ ref, from, kind });
  };

  /* ------------------------------------------------ CSS */
  const cssCache = new Map();
  function cssFor(path, depth = 0) {
    if (cssCache.has(path)) return cssCache.get(path);
    cssCache.set(path, ''); // guards @import cycles
    const out = rewriteCss(textOf(path) ?? '', path, depth);
    cssCache.set(path, out);
    return out;
  }

  function rewriteCss(css, fromPath, depth = 0) {
    const { ast } = parseCss(css);
    if (!ast) return css;
    const edits = [];
    walk(ast, {
      enter(node) {
        if (node.type === 'Atrule' && node.name.toLowerCase() === 'import' && node.prelude) {
          let ref = null;
          let hasMedia = false;
          for (const c of node.prelude.children.toArray()) {
            if (c.type === 'Url') ref = typeof c.value === 'string' ? c.value : c.value?.value;
            else if (c.type === 'String') ref = c.value;
            else hasMedia = true;
          }
          if (ref && !isExternalUrl(ref)) {
            const target = resolve(fromPath, ref);
            if (target && files.get(target)?.kind === 'css' && depth < MAX_DEPTH) {
              const inner = cssFor(target, depth + 1);
              edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, replacement: hasMedia ? '' : inner });
              return walk.skip;
            }
            if (!target) noteMissing(ref, fromPath, 'import');
          }
          return walk.skip;
        }
        if (node.type === 'Url') {
          const ref = typeof node.value === 'string' ? node.value : node.value?.value;
          if (!ref || isExternalUrl(ref) || ref.startsWith('#')) return undefined;
          const target = resolve(fromPath, ref);
          const url = target ? assetUrl(target) : null;
          if (url) edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, replacement: `url("${url}")` });
          else if (!target) {
            noteMissing(ref, fromPath, 'asset');
            edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, replacement: `url("${INERT}")` });
          }
        }
        return undefined;
      },
    });
    return edits.length ? applyEdits(css, edits).text : css;
  }

  /* ------------------------------------------------ JS modules */
  const moduleCache = new Map();
  function moduleCode(path, text, fromPath, stack) {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const parsed = parseJs(text, { filename: path, sourceType: 'module' });
    if (!parsed.ok) {
      warnings.push(`${path}: could not be parsed for the preview (${parsed.error.message}).`);
      return text;
    }
    const edits = [];
    const visitSource = (srcNode) => {
      if (!srcNode || srcNode.type !== 'Literal' || typeof srcNode.value !== 'string') return;
      const spec = srcNode.value;
      if (isExternalUrl(spec)) return;
      if (!/^(?:\.{0,2}\/|\/)/.test(spec)) {
        warnings.push(`${path}: bare import "${spec}" can't be resolved in the preview (it needs a bundler or import map).`);
        return;
      }
      const target = resolve(fromPath || path, spec);
      if (!target) {
        noteMissing(spec, path, 'import');
        return;
      }
      if (files.get(target)?.kind !== 'js') return;
      if (stack.includes(target)) {
        warnings.push(`Circular import ${path} → ${target} can't be previewed; that import was left as-is.`);
        return;
      }
      const dep = moduleCode(target, textOf(target) ?? '', target, [...stack, target]);
      edits.push({ start: srcNode.start, end: srcNode.end, replacement: JSON.stringify('data:text/javascript;charset=utf-8,' + encodeURIComponent(dep)) });
    };
    const walkNode = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source)) visitSource(n.source);
      else if (n.type === 'ImportExpression') visitSource(n.source);
      for (const k in n) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(walkNode);
        else if (v && typeof v.type === 'string') walkNode(v);
      }
    };
    walkNode(parsed.ast);
    const out = edits.length ? applyEdits(text, edits).text : text;
    moduleCache.set(path, out);
    return out;
  }

  /* ------------------------------------------------ HTML */
  const edits = [];
  let headInsert = -1;
  let docInsert = 0;
  for (const n of document.children || []) if (n.type === 'directive') docInsert = n.endIndex + 1;

  const rewriteAttrUrl = (el, attr) => {
    const v = el.attribs[attr];
    if (!v || isExternalUrl(v) || v.startsWith('#')) return null;
    const target = resolve(htmlPath, v);
    if (!target) {
      noteMissing(v, htmlPath, el.name);
      return INERT;
    }
    return assetUrl(target);
  };
  /** Adds the rewritten attribute (and remembers what it used to point to when it is missing). */
  const setUrl = (overrides, el, attr, url) => {
    if (!url) return;
    overrides[attr] = url;
    if (url === INERT) overrides['data-cp-missing'] = el.attribs[attr];
  };

  walkElements(document, (el) => {
    const attrs = el.attribs || {};
    const name = el.name;
    if ((name === 'head' || name === 'html') && headInsert < 0 && el.startIndex != null) {
      if (name === 'head') headInsert = startTagEnd(html, el.startIndex) + 1;
      else docInsert = startTagEnd(html, el.startIndex) + 1;
    }
    if (el.startIndex == null) return;
    const tagEnd = startTagEnd(html, el.startIndex);

    switch (name) {
      case 'link': {
        const rel = (attrs.rel || '').toLowerCase();
        if (!attrs.href || isExternalUrl(attrs.href)) break;
        if (rel.split(/\s+/).includes('stylesheet')) {
          const target = resolve(htmlPath, attrs.href);
          if (target && files.get(target)?.kind === 'css') {
            const media = attrs.media ? ` media="${escapeAttr(attrs.media)}"` : '';
            edits.push({ start: el.startIndex, end: tagEnd + 1, replacement: `<style data-src="${escapeAttr(target)}"${media}>${escapeStyle(cssFor(target))}</style>` });
          } else if (!target) {
            noteMissing(attrs.href, htmlPath, 'stylesheet');
            edits.push({ start: el.startIndex, end: tagEnd + 1, replacement: rebuildTag(el, { href: INERT, 'data-cp-missing': attrs.href }) });
          }
        } else {
          const overrides = {};
          setUrl(overrides, el, 'href', rewriteAttrUrl(el, 'href'));
          if (overrides.href) edits.push({ start: el.startIndex, end: tagEnd + 1, replacement: rebuildTag(el, overrides) });
        }
        break;
      }
      case 'script': {
        if (!attrs.src) {
          const type = (attrs.type || '').toLowerCase();
          if (type === 'module' && el.children && el.children[0]) {
            const c = el.children[0];
            const code = html.slice(c.startIndex, el.children[el.children.length - 1].endIndex + 1);
            edits.push({ start: c.startIndex, end: el.children[el.children.length - 1].endIndex + 1, replacement: escapeScript(moduleCode(`${htmlPath}#inline`, code, htmlPath, [htmlPath])) });
          }
          break;
        }
        if (isExternalUrl(attrs.src)) break;
        const target = resolve(htmlPath, attrs.src);
        const end = el.endIndex != null ? el.endIndex + 1 : tagEnd + 1;
        if (!target) {
          noteMissing(attrs.src, htmlPath, 'script');
          edits.push({ start: el.startIndex, end, replacement: `${rebuildTag(el, { src: INERT, 'data-cp-missing': attrs.src })}</script>` });
          break;
        }
        if (files.get(target)?.kind !== 'js') break;
        const isModule = (attrs.type || '').toLowerCase() === 'module';
        const text = textOf(target) ?? '';
        const code = isModule ? moduleCode(target, text, target, [target]) : text;
        const rest = { ...attrs };
        delete rest.src;
        if (!isModule && ('defer' in rest || 'async' in rest)) {
          // inline scripts ignore defer/async; a data: URL keeps the original timing
          const open = rebuildTag({ name: 'script', attribs: { ...rest, src: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code), 'data-src': target } }, {});
          edits.push({ start: el.startIndex, end, replacement: `${open}</script>` });
        } else {
          const open = rebuildTag({ name: 'script', attribs: { ...rest, 'data-src': target } }, {});
          edits.push({ start: el.startIndex, end, replacement: `${open}${escapeScript(code)}</script>` });
        }
        break;
      }
      case 'style': {
        const kids = el.children;
        if (kids && kids.length) {
          const s = kids[0].startIndex;
          const e = kids[kids.length - 1].endIndex + 1;
          const rewritten = rewriteCss(html.slice(s, e), htmlPath);
          if (rewritten !== html.slice(s, e)) edits.push({ start: s, end: e, replacement: escapeStyle(rewritten) });
        }
        break;
      }
      case 'img':
      case 'source':
      case 'video':
      case 'audio':
      case 'track':
      case 'embed':
      case 'iframe':
      case 'input':
      case 'object': {
        const overrides = {};
        for (const a of ['src', 'poster', 'data']) {
          if (attrs[a]) setUrl(overrides, el, a, rewriteAttrUrl(el, a));
        }
        if (attrs.srcset) {
          const parts = attrs.srcset.split(',').map((c) => {
            const [u, ...rest] = c.trim().split(/\s+/);
            if (!u || isExternalUrl(u)) return c.trim();
            const target = resolve(htmlPath, u);
            const url = target ? assetUrl(target) : null;
            if (!target) noteMissing(u, htmlPath, name);
            return [url || (target ? u : INERT), ...rest].join(' ');
          });
          overrides.srcset = parts.join(', ');
        }
        if (Object.keys(overrides).length) edits.push({ start: el.startIndex, end: tagEnd + 1, replacement: rebuildTag(el, overrides) });
        break;
      }
      default:
        break;
    }
  });

  const injection = (blockNetwork ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CSP)}">` : '') + `<script>${diagnosticsScript(previewId)}</script>`;
  const at = headInsert >= 0 ? headInsert : docInsert;
  edits.push({ start: at, end: at, replacement: injection });

  return { html: applyEdits(html, edits).text, warnings, missing };
}
