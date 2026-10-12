/**
 * Turns what JavaScript does to the DOM into universe evidence:
 * resolves every recorded sink with the constant resolver and registers exact
 * tokens, fragment patterns, or — when nothing can be said — an "unresolved write".
 */
import { walkAst } from '../parsers/jsParser.js';
import { parseHtml, walkElements } from '../parsers/htmlParser.js';
import { collectSelectorTokens, parseSelectorString } from '../parsers/selectorParser.js';
import { isFullyUnknown, resolveAlts, WILD } from './jsConstResolver.js';

const TOKEN_CHARS = new RegExp(`^[A-Za-z0-9_\\-:/.%${WILD}]+$`);

/**
 * @param {import('./universe.js').Universe} uni
 * @param {any[]} ctxs analysed JS file contexts
 * @param {any} project resolver project facade
 * @param {{ external?: boolean }} [opts] external: third-party scripts read for evidence only
 */
export function applyJsEvidence(uni, ctxs, project, opts = {}) {
  for (const ctx of ctxs) {
    const file = ctx.displayPath;
    const vendor = !!opts.external || isVendorLibrary(ctx);

    for (const s of ctx.strings) uni.addWords(s, file);
    for (const n of ctx.attrNames) uni.jsAttr(n, `${file} (attribute name)`);
    for (const t of ctx.tagNames) uni.jsTag(t, `${file} (constructor)`);
    for (const t of ctx.jsxTags) uni.jsTag(t, `${file} (JSX)`);
    for (const { name, value } of ctx.attrValues) uni.jsAttrValue(name, value, `${file} (attribute value)`);
    for (const h of ctx.htmlStrings) addHtmlEvidence(uni, h.text, `${file} (HTML string)`);
    for (const sel of ctx.domSelectors) {
      if (sel.selector !== '(dynamic)') addSelectorEvidence(uni, sel.selector, `${file}:${sel.line} (${sel.method})`);
    }

    for (const sink of ctx.sinks) {
      const rc = { project, seen: new Set() };
      let alts;
      try {
        alts = resolveAlts(sink.node, sink.scope, rc, 0);
      } catch {
        alts = [WILD];
      }
      const ev = `${file}:${sink.line} (${sink.how})`;
      applySink(uni, sink, alts, ev, vendor);
    }
  }
}

/**
 * Well-known third-party libraries (jQuery, Bootstrap, plugins…). Their generic DOM helpers
 * (`addClass(value)`, `html(value)`, `style.setProperty(name, value)`) only pass on values
 * that come from the site's own code — which is analysed on its own, together with every
 * string literal the library contains. So an opaque write inside such a library is not
 * evidence of class names we cannot see, and must not downgrade every unused rule on the site.
 */
const VENDOR_FILE = /^(jquery|bootstrap|popper|magnific-popup|slick|swiper|owl\.carousel|isotope|masonry|imagesloaded|lightbox|fancybox|select2|aos|wow|gsap|scrolltrigger|lodash|underscore|moment|axios|modernizr|lazysizes|splide|glide|flickity|photoswipe|choices|flatpickr|chart|datatables|waypoints|typed|particles)([.\-][\w.\-]*)?\.js$/i;
const VENDOR_DIR = /(^|\/)(vendor|vendors|node_modules)\//i;
const VENDOR_BANNER = /^\s*\/\*!?[\s*]*(jQuery|Bootstrap|Popper|Swiper|Magnific Popup|Slick|GSAP|Lodash|Isotope|Masonry|Owl Carousel|Select2|Chart\.js|AOS|WOW)\b/i;

export function isVendorLibrary(ctx) {
  const unit = ctx.unit || {};
  if (unit.inline || unit.handlers) return false;
  const path = String(ctx.path || unit.path || '');
  const base = path.split('/').pop();
  return VENDOR_FILE.test(base) || VENDOR_DIR.test(path) || VENDOR_BANNER.test(String(unit.text || '').slice(0, 400));
}

function applySink(uni, sink, alts, ev, vendor = false) {
  // In a vendor library an opaque write is a pass-through (see isVendorLibrary): record what
  // can be resolved, but never report it as an unresolved write.
  if (vendor) sink = { ...sink, passive: true, adds: false };
  const adds = !!sink.adds;
  switch (sink.kind) {
    case 'class': {
      let unresolved = false;
      for (const alt of alts) {
        const tokens = alt.split(/\s+/).filter(Boolean);
        if (!tokens.length) continue;
        for (const t of tokens) {
          if (!t.includes(WILD)) uni.jsClass(t, ev);
          else if (isFullyUnknown(t) || !uni.addPattern('class', t, ev)) unresolved = true;
        }
      }
      if (unresolved && adds && !sink.passive) uni.unresolved.class.push(ev);
      break;
    }
    case 'id': {
      let unresolved = false;
      for (const alt of alts) {
        const t = alt.trim();
        if (!t) continue;
        if (!t.includes(WILD)) uni.jsId(t, ev);
        else if (isFullyUnknown(t) || !uni.addPattern('id', t, ev)) unresolved = true;
      }
      if (unresolved && adds) uni.unresolved.id.push(ev);
      break;
    }
    case 'tag': {
      let unresolved = false;
      for (const alt of alts) {
        const t = alt.trim();
        if (!t) continue;
        if (!t.includes(WILD)) uni.jsTag(t, ev);
        else unresolved = true;
      }
      if (unresolved && adds) uni.unresolved.tag.push(ev);
      break;
    }
    case 'attr': {
      let unresolved = false;
      for (const alt of alts) {
        const t = alt.trim().toLowerCase();
        if (!t) continue;
        if (!t.includes(WILD)) uni.jsAttr(t, ev);
        else if (isFullyUnknown(t) || !uni.addPattern('attr', t, ev)) unresolved = true;
      }
      if (unresolved && adds) uni.unresolved.attr.push(ev);
      break;
    }
    case 'attr-data':
      uni.addPattern('attr', `data-${WILD}`, ev);
      break;
    case 'selector': {
      for (const alt of alts) {
        if (!alt.includes(WILD)) addSelectorEvidence(uni, alt, ev);
        else {
          const re = /([.#])([\w\-]+)/g;
          let m;
          while ((m = re.exec(alt))) {
            const kind = m[1] === '.' ? 'class' : 'id';
            if (!m[2].includes(WILD)) (kind === 'class' ? uni.jsClass(m[2], ev) : uni.jsId(m[2], ev));
            else uni.addPattern(kind, m[2], ev);
          }
        }
      }
      break;
    }
    case 'html': {
      let sawMarkup = false;
      let fully = false;
      for (const alt of alts) {
        if (isFullyUnknown(alt)) {
          fully = true;
          continue;
        }
        if (alt.includes('<')) {
          sawMarkup = true;
          addHtmlEvidence(uni, alt, ev);
        }
      }
      if (fully && adds && !sink.passive && !sawMarkup && !subtreeHasMarkup(sink.node)) uni.unresolved.html.push(ev);
      break;
    }
    case 'style': {
      let fully = false;
      for (const alt of alts) {
        if (isFullyUnknown(alt)) fully = true;
        else uni.addWords(alt.split(WILD).join(' '), ev);
      }
      if (fully && adds && !sink.passive) uni.unresolved.style.push(ev);
      break;
    }
    case 'concat': {
      for (const alt of alts) {
        if (!alt.includes(WILD)) continue;
        for (const token of alt.split(/\s+/)) {
          if (token.includes(WILD) && TOKEN_CHARS.test(token) && token.split(WILD).join('').length >= 3) uni.addPattern('any', token, ev);
        }
      }
      break;
    }
    default:
      break;
  }
}

function subtreeHasMarkup(node) {
  let found = false;
  walkAst(node, (n) => {
    if (found) return false;
    if (n.type === 'TemplateLiteral' && n.quasis.some((q) => /<[a-zA-Z]/.test(q.value.cooked || ''))) found = true;
    else if (n.type === 'Literal' && typeof n.value === 'string' && /<[a-zA-Z]/.test(n.value)) found = true;
    else if (n.type === 'JSXElement') found = true;
    return undefined;
  });
  return found;
}

function addSelectorEvidence(uni, selector, ev) {
  const models = parseSelectorString(selector);
  if (!models) return;
  const t = collectSelectorTokens(models);
  for (const c of t.classes) uni.jsClass(c, ev);
  for (const i of t.ids) uni.jsId(i, ev);
  for (const tag of t.tags) uni.jsTag(tag, ev);
  for (const a of t.attrs) uni.jsAttr(a, ev);
}

/** Registers classes/ids/tags/attributes found in an HTML string created by JavaScript. */
export function addHtmlEvidence(uni, html, ev) {
  const { document } = parseHtml(html);
  if (!document) return;
  walkElements(document, (el) => {
    uni.jsTag(el.name, ev);
    const attrs = el.attribs || {};
    for (const name in attrs) {
      const value = attrs[name];
      if (name === 'class') {
        for (const t of value.split(/\s+/).filter(Boolean)) {
          if (t.includes(WILD)) uni.addPattern('class', t, ev);
          else uni.jsClass(t, ev);
        }
      } else if (name === 'id') {
        if (value.includes(WILD)) uni.addPattern('id', value, ev);
        else if (value) uni.jsId(value, ev);
      } else {
        uni.jsAttr(name, ev);
        if (value && !value.includes(WILD)) uni.jsAttrValue(name, value, ev);
      }
    }
  });
}
