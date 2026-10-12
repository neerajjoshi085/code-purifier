/**
 * The "universe" is everything the project can put on screen: static HTML
 * elements plus every name JavaScript is able to add. CSS selectors are judged
 * against it (selectorMatcher.js).
 */
import { escapeRegExp } from '../utils/text.js';
import { WILD } from './jsConstResolver.js';

const WORD_RE = /[A-Za-z_][\w-]*/g;

export class Universe {
  constructor() {
    /** @type {{tag:string,id:string|null,classes:string[],attrs:Record<string,string>}[]} */
    this.elements = [];
    this.tagIndex = new Map();
    this.classIndex = new Map();
    this.idIndex = new Map();
    this.attrIndex = new Map();
    this.hasHtml = false;
    this.htmlWords = new Set();
    this.styleAttrs = [];
    this.js = {
      classes: new Map(),
      ids: new Map(),
      tags: new Map(),
      attrs: new Map(),
      attrValues: new Map(),
      words: new Map(),
      patterns: [],
      varNames: new Set(),
      stringChunks: [],
    };
    this._blob = null;
    /** Writes the analyzer could not resolve — the reason unused selectors become UNKNOWN. */
    this.unresolved = { class: [], id: [], tag: [], attr: [], html: [], style: [] };
    /** Reasons why the universe may be incomplete (parse failures, missing HTML). */
    this.incomplete = [];
    this.safelist = { exact: new Set(), regex: [] };
    this._coCache = new Map();
  }

  /* ------------------------------------------------------------ HTML */

  addElement(el) {
    const idx = this.elements.length;
    this.elements.push(el);
    push(this.tagIndex, el.tag, idx);
    if (el.id) push(this.idIndex, el.id, idx);
    for (const c of el.classes) push(this.classIndex, c, idx);
    for (const a in el.attrs) push(this.attrIndex, a, idx);
  }

  addHtml(analysis) {
    this.hasHtml = true;
    for (const el of analysis.elements) this.addElement(el);
    for (const w of analysis.words) this.htmlWords.add(w);
    for (const s of analysis.styleAttrs) this.styleAttrs.push(s);
  }

  /* ------------------------------------------------------------ JS evidence */

  jsClass(token, ev) {
    if (!this.js.classes.has(token)) this.js.classes.set(token, ev);
  }
  jsId(token, ev) {
    if (!this.js.ids.has(token)) this.js.ids.set(token, ev);
  }
  jsTag(token, ev) {
    const t = token.toLowerCase();
    if (!this.js.tags.has(t)) this.js.tags.set(t, ev);
  }
  jsAttr(name, ev) {
    const n = name.toLowerCase();
    if (!this.js.attrs.has(n)) this.js.attrs.set(n, ev);
  }
  jsAttrValue(name, value, ev) {
    const n = name.toLowerCase();
    let m = this.js.attrValues.get(n);
    if (!m) this.js.attrValues.set(n, (m = new Map()));
    if (!m.has(value)) m.set(value, ev);
  }

  /** Splits a string literal into the tokens it could contribute (class names, ids, …). */
  addWords(str, file) {
    const ev = `${file} (string literal)`;
    const w = this.js.words;
    if (str.length <= 300) this.js.stringChunks.push(str);
    if (str.includes('--')) for (const m of str.matchAll(/--[A-Za-z_][\w-]*/g)) this.js.varNames.add(m[0]);
    for (const t of str.split(/\s+/)) {
      if (t && t.length <= 120 && !w.has(t)) w.set(t, ev);
    }
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(str))) {
      if (m[0].length <= 120 && !w.has(m[0])) w.set(m[0], ev);
    }
  }

  /** All short JS string literals joined (lower-cased) — used for multi-word names such as font families. */
  get stringBlob() {
    if (this._blob === null) this._blob = this.js.stringChunks.join('\n').toLowerCase();
    return this._blob;
  }

  /**
   * Registers a fragment containing WILD markers, e.g. `btn-` (from 'btn-' + type).
   * Returns false if the fragment is too generic to be useful.
   */
  addPattern(kind, token, ev) {
    const chunks = token.split(WILD);
    const literal = chunks.join('');
    if (literal.length < 2) return false;
    const regex = new RegExp('^' + chunks.map(escapeRegExp).join('.*') + '$');
    this.js.patterns.push({ kind, regex, source: token.split(WILD).join('*'), ev });
    return true;
  }

  matchPattern(kind, name) {
    for (const p of this.js.patterns) {
      if ((p.kind === kind || p.kind === 'any') && p.regex.test(name)) return p;
    }
    return null;
  }

  /* ------------------------------------------------------------ safelist */

  setSafelist(entries) {
    this.safelist = { exact: new Set(), regex: [] };
    for (const raw of entries || []) {
      const e = String(raw).trim();
      if (!e) continue;
      const m = /^\/(.+)\/([a-z]*)$/.exec(e);
      if (m) {
        try {
          this.safelist.regex.push(new RegExp(m[1], m[2]));
        } catch {
          /* ignore invalid regex */
        }
      } else if (e.includes('*')) {
        this.safelist.regex.push(new RegExp('^' + e.replace(/^[.#]/, '').split('*').map(escapeRegExp).join('.*') + '$'));
      } else this.safelist.exact.add(e.replace(/^[.#]/, ''));
    }
  }

  isSafelisted(name) {
    if (this.safelist.exact.has(name)) return true;
    for (const r of this.safelist.regex) if (r.test(name)) return true;
    return false;
  }

  /* ------------------------------------------------------------ helpers */

  /** Is there a static element having ALL of the given requirements? Memoised. */
  coOccurs(reqs) {
    const key = reqs.map((r) => `${r.t}:${r.v ?? ''}:${r.name ?? ''}:${r.op ?? ''}:${r.value ?? ''}:${r.flags ?? ''}`).join('|');
    const cached = this._coCache.get(key);
    if (cached !== undefined) return cached;
    let best = null;
    for (const r of reqs) {
      const list = r.t === 'tag' ? this.tagIndex.get(r.v) : r.t === 'class' ? this.classIndex.get(r.v) : r.t === 'id' ? this.idIndex.get(r.v) : this.attrIndex.get(r.name);
      if (!list) {
        this._coCache.set(key, false);
        return false;
      }
      if (!best || list.length < best.length) best = list;
    }
    let found = false;
    if (!best) found = this.elements.length > 0;
    else {
      for (const idx of best) {
        if (elementMatches(this.elements[idx], reqs)) {
          found = true;
          break;
        }
      }
    }
    this._coCache.set(key, found);
    return found;
  }
}

function push(map, key, idx) {
  const arr = map.get(key);
  if (arr) arr.push(idx);
  else map.set(key, [idx]);
}

export function attrValueMatches(actual, op, expected, flags) {
  if (expected === null || expected === undefined || !op) return true;
  let a = actual;
  let e = expected;
  if (flags && flags.toLowerCase().includes('i')) {
    a = a.toLowerCase();
    e = e.toLowerCase();
  }
  switch (op) {
    case '=':
      return a === e;
    case '~=':
      return a.split(/\s+/).includes(e);
    case '|=':
      return a === e || a.startsWith(e + '-');
    case '^=':
      return e !== '' && a.startsWith(e);
    case '$=':
      return e !== '' && a.endsWith(e);
    case '*=':
      return e !== '' && a.includes(e);
    default:
      return true;
  }
}

function elementMatches(el, reqs) {
  for (const r of reqs) {
    switch (r.t) {
      case 'tag':
        if (el.tag !== r.v) return false;
        break;
      case 'class':
        if (!el.classes.includes(r.v)) return false;
        break;
      case 'id':
        if (el.id !== r.v) return false;
        break;
      case 'attr': {
        const v = el.attrs[r.name];
        if (v === undefined) return false;
        if (!attrValueMatches(v, r.op, r.value, r.flags)) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}
