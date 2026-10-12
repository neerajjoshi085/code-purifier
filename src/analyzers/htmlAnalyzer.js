/**
 * HTML Analyzer — extracts everything the CSS/JS analyzers need to know about a page:
 * elements (tag/id/classes/attributes), inline <style>/<script> blocks, inline event
 * handlers, linked resources and inline style attributes.
 */
import { parseHtml, rawTextRange, walkElements } from '../parsers/htmlParser.js';
import { buildLineIndex, offsetToLine } from '../utils/text.js';

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript', 'module', 'text/jsx', 'jsx']);

/**
 * @typedef {Object} HtmlAnalysis
 * @property {string} path
 * @property {boolean} ok
 * @property {string|null} error
 * @property {{tag:string,id:string|null,classes:string[],attrs:Record<string,string>}[]} elements
 * @property {{start:number,end:number,text:string,media:string|null,line:number,index:number}[]} inlineStyles
 * @property {{start:number,end:number,text:string,type:string,isModule:boolean,line:number,index:number}[]} inlineScripts
 * @property {{ attr:string, code:string, tag:string, line:number }[]} eventHandlers
 * @property {{ src:string, module:boolean, async:boolean, defer:boolean, line:number }[]} scriptRefs
 * @property {{ href:string, media:string|null, line:number }[]} styleRefs
 * @property {{ kind:string, url:string, tag:string, attr:string, line:number }[]} resourceRefs
 * @property {string[]} styleAttrs
 * @property {Set<string>} words
 * @property {Record<string,string>|null} importMap
 */

/**
 * @param {string} path
 * @param {string} text
 * @returns {HtmlAnalysis}
 */
export function analyzeHtml(path, text) {
  const lineStarts = buildLineIndex(text);
  const lineOf = (offset) => offsetToLine(lineStarts, offset);
  const { document, error } = parseHtml(text);
  const out = {
    path,
    ok: !!document,
    error,
    size: text.length,
    elements: [],
    inlineStyles: [],
    inlineScripts: [],
    eventHandlers: [],
    scriptRefs: [],
    styleRefs: [],
    resourceRefs: [],
    styleAttrs: [],
    words: new Set(),
    importMap: null,
    tags: new Set(),
  };
  if (!document) return out;

  let scriptIndex = 0;
  let styleIndex = 0;

  walkElements(document, (el) => {
    const tag = el.name;
    const attrs = el.attribs || {};
    out.tags.add(tag);
    const classes = attrs.class ? attrs.class.split(/\s+/).filter(Boolean) : [];
    out.elements.push({ tag, id: attrs.id || null, classes, attrs });

    for (const name in attrs) {
      const value = attrs[name];
      if (name.length > 2 && name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110 && value) {
        out.eventHandlers.push({ attr: name, code: value, tag, line: lineOf(el.startIndex ?? 0) });
      }
      if (name === 'style' && value) out.styleAttrs.push(value);
      if (name === 'href' && /^\s*javascript:/i.test(value)) {
        out.eventHandlers.push({ attr: 'href', code: value.replace(/^\s*javascript:/i, ''), tag, line: lineOf(el.startIndex ?? 0) });
      }
      if (value && value.length <= 600 && name !== 'style') collectWords(value, out.words);
    }

    const line = lineOf(el.startIndex ?? 0);
    switch (tag) {
      case 'style': {
        const r = rawTextRange(el, text);
        if (r && r.text.trim()) out.inlineStyles.push({ ...r, media: attrs.media || null, line: lineOf(r.start), index: ++styleIndex });
        break;
      }
      case 'script': {
        const type = (attrs.type || '').trim().toLowerCase();
        if (attrs.src) {
          out.scriptRefs.push({ src: attrs.src, module: type === 'module', async: 'async' in attrs, defer: 'defer' in attrs, line });
          break;
        }
        const r = rawTextRange(el, text);
        if (!r || !r.text.trim()) break;
        if (type === 'importmap') {
          try {
            const json = JSON.parse(r.text);
            out.importMap = { ...(json.imports || {}) };
          } catch {
            /* ignore malformed import maps */
          }
        } else if (JS_TYPES.has(type)) {
          out.inlineScripts.push({ ...r, type, isModule: type === 'module', line: lineOf(r.start), index: ++scriptIndex });
        }
        break;
      }
      case 'link': {
        const rel = (attrs.rel || '').toLowerCase();
        if (attrs.href) {
          if (rel.split(/\s+/).includes('stylesheet')) out.styleRefs.push({ href: attrs.href, media: attrs.media || null, line });
          else out.resourceRefs.push({ kind: 'link', url: attrs.href, tag, attr: 'href', line });
        }
        break;
      }
      case 'img':
      case 'source':
      case 'video':
      case 'audio':
      case 'iframe':
      case 'embed':
      case 'track':
      case 'input':
      case 'object': {
        for (const attr of ['src', 'poster', 'data']) {
          if (attrs[attr]) out.resourceRefs.push({ kind: tag, url: attrs[attr], tag, attr, line });
        }
        if (attrs.srcset) {
          for (const candidate of attrs.srcset.split(',')) {
            const url = candidate.trim().split(/\s+/)[0];
            if (url) out.resourceRefs.push({ kind: tag, url, tag, attr: 'srcset', line });
          }
        }
        break;
      }
      default:
        break;
    }
  });

  return out;
}

function collectWords(value, set) {
  const re = /[A-Za-z_$][\w$-]*/g;
  let m;
  while ((m = re.exec(value))) set.add(m[0]);
}
