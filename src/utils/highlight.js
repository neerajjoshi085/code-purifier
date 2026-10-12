/**
 * Small stateful line tokenizers (CSS, JavaScript, HTML) used by the code viewer.
 *
 * Each tokenizer is `(line, state) => [tokens, nextState]` where `state` is a small
 * integer describing what is open at the start of the line (block comment, template
 * literal, brace depth…). That lets the virtualised viewer highlight any visible line
 * after computing line-start states once, without tokenising the whole file again.
 */

const JS_KEYWORDS = new Set(
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while with yield async await of from as get set null true false undefined'.split(' '),
);
const REGEX_BEFORE_KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);

const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c > '\x7f';
const isIdentPart = (c) => isIdentStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';

export const MAX_HIGHLIGHT_LINE = 1500;

/** Merges adjacent tokens of the same type. */
function pusher(out) {
  return (t, v) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === t) last.v += v;
    else out.push({ t, v });
  };
}

/* ------------------------------------------------------------------ JavaScript */

// state: 0 normal | 1 in /* comment */ | 2 in `template`
export function tokenizeJs(line, state = 0) {
  const out = [];
  const push = pusher(out);
  const n = line.length;
  let i = 0;
  let prev = ''; // previous significant token: punctuation char, or 'id' | 'num' | 'str' | keyword

  const scanTemplate = (from) => {
    let j = from;
    while (j < n) {
      if (line[j] === '\\') j += 2;
      else if (line[j] === '`') return j + 1;
      else j++;
    }
    return -1;
  };

  if (state === 1) {
    const end = line.indexOf('*/');
    if (end < 0) return [[{ t: 'com', v: line }], 1];
    push('com', line.slice(0, end + 2));
    i = end + 2;
    state = 0;
  } else if (state === 2) {
    const end = scanTemplate(0);
    if (end < 0) return [[{ t: 'str', v: line }], 2];
    push('str', line.slice(0, end));
    i = end;
    state = 0;
    prev = 'str';
  }

  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      let j = i + 1;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push('', line.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') {
      push('com', line.slice(i));
      break;
    }
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end < 0) {
        push('com', line.slice(i));
        return [out, 1];
      }
      push('com', line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      push('str', line.slice(i, Math.min(n, j + 1)));
      i = Math.min(n, j + 1);
      prev = 'str';
      continue;
    }
    if (c === '`') {
      const end = scanTemplate(i + 1);
      if (end < 0) {
        push('str', line.slice(i));
        return [out, 2];
      }
      push('str', line.slice(i, end));
      i = end;
      prev = 'str';
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(line[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(line[j])) j++;
      push('num', line.slice(i, j));
      i = j;
      prev = 'num';
      continue;
    }
    if (isIdentStart(c) || c === '#') {
      let j = i + 1;
      while (j < n && isIdentPart(line[j])) j++;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && line[k] === ' ') k++;
      if (JS_KEYWORDS.has(word) && prev !== '.') {
        push('kw', word);
        prev = REGEX_BEFORE_KW.has(word) ? '' : 'kw';
      } else if (line[k] === '(') {
        push('fn', word);
        prev = 'id';
      } else if (prev === '.') {
        push('prop', word);
        prev = 'id';
      } else {
        push('', word);
        prev = 'id';
      }
      i = j;
      continue;
    }
    if (c === '/') {
      const regexAllowed = prev === '' || !(prev === 'id' || prev === 'num' || prev === 'str' || prev === ')' || prev === ']' || prev === 'kw');
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const d = line[j];
          if (d === '\\') j += 2;
          else if (d === '[') {
            inClass = true;
            j++;
          } else if (d === ']') {
            inClass = false;
            j++;
          } else if (d === '/' && !inClass) break;
          else j++;
        }
        if (j < n) {
          j++;
          while (j < n && /[a-z]/i.test(line[j])) j++;
          push('re', line.slice(i, j));
          i = j;
          prev = 'str';
          continue;
        }
      }
    }
    push('punc', c);
    prev = c;
    i++;
  }
  return [out, state];
}

/* ------------------------------------------------------------------ CSS */

// state bits: 1 comment | 2 inValue | 4..7 depth | 8.. stack (1 = declaration block) | 1<<20 prelude-is-at | 1<<21 at-is-declaration
const CSS_DECL_AT = new Set(['font-face', 'page', 'property', 'counter-style', 'font-feature-values', 'view-transition', 'position-try', 'font-palette-values', 'viewport']);
const DEPTH_SHIFT = 2;
const STACK_SHIFT = 8;

export function tokenizeCss(line, state = 0) {
  const out = [];
  const push = pusher(out);
  const n = line.length;
  let i = 0;
  let comment = state & 1;
  let inValue = (state >> 1) & 1;
  let depth = (state >> DEPTH_SHIFT) & 15;
  let stack = (state >> STACK_SHIFT) & 0xfff;
  let preludeAt = (state >> 20) & 1;
  let atDecl = (state >> 21) & 1;
  const inDecl = () => depth > 0 && ((stack >> (depth - 1)) & 1) === 1;
  const pack = () => comment | (inValue << 1) | (depth << DEPTH_SHIFT) | (stack << STACK_SHIFT) | (preludeAt << 20) | (atDecl << 21);

  if (comment) {
    const end = line.indexOf('*/');
    if (end < 0) return [[{ t: 'com', v: line }], state];
    push('com', line.slice(0, end + 2));
    i = end + 2;
    comment = 0;
  }

  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      let j = i + 1;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push('', line.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end < 0) {
        push('com', line.slice(i));
        comment = 1;
        return [out, pack()];
      }
      push('com', line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      push('str', line.slice(i, Math.min(n, j + 1)));
      i = Math.min(n, j + 1);
      continue;
    }
    if (c === '{') {
      const isDecl = preludeAt ? atDecl === 1 : true;
      stack = (stack & ~(1 << depth)) | (isDecl ? 1 << depth : 0);
      depth = Math.min(15, depth + 1);
      preludeAt = 0;
      atDecl = 0;
      inValue = 0;
      push('punc', c);
      i++;
      continue;
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      inValue = 0;
      preludeAt = 0;
      atDecl = 0;
      push('punc', c);
      i++;
      continue;
    }
    if (c === ';') {
      inValue = 0;
      if (!inDecl()) {
        preludeAt = 0;
        atDecl = 0;
      }
      push('punc', c);
      i++;
      continue;
    }
    if (inDecl()) {
      if (!inValue) {
        if (c === ':') {
          inValue = 1;
          push('punc', c);
          i++;
          continue;
        }
        // property name
        let j = i;
        while (j < n && line[j] !== ':' && line[j] !== ';' && line[j] !== '}' && line[j] !== ' ' && line[j] !== '\t') j++;
        const word = line.slice(i, j);
        if (word) push(word.startsWith('--') ? 'var' : 'prop', word);
        i = Math.max(j, i + 1);
        continue;
      }
      // value
      if (c === '#' && /[0-9a-fA-F]/.test(line[i + 1] || '')) {
        let j = i + 1;
        while (j < n && /[0-9a-zA-Z]/.test(line[j])) j++;
        push('num', line.slice(i, j));
        i = j;
        continue;
      }
      if (isDigit(c) || ((c === '.' || c === '-' || c === '+') && isDigit(line[i + 1] || '')) || (c === '.' && isDigit(line[i + 1] || ''))) {
        let j = i + 1;
        while (j < n && (isDigit(line[j]) || line[j] === '.')) j++;
        while (j < n && /[a-zA-Z%]/.test(line[j])) j++;
        push('num', line.slice(i, j));
        i = j;
        continue;
      }
      if (c === '!' ) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(line[j])) j++;
        push('kw', line.slice(i, j));
        i = j;
        continue;
      }
      if (c === '-' && line[i + 1] === '-') {
        let j = i + 2;
        while (j < n && /[\w-]/.test(line[j])) j++;
        push('var', line.slice(i, j));
        i = j;
        continue;
      }
      if (isIdentStart(c) || c === '-') {
        let j = i + 1;
        while (j < n && /[\w-]/.test(line[j])) j++;
        push(line[j] === '(' ? 'fn' : '', line.slice(i, j));
        i = j;
        continue;
      }
      push('punc', c);
      i++;
      continue;
    }
    // selector / at-rule prelude context
    if (c === '@') {
      let j = i + 1;
      while (j < n && /[\w-]/.test(line[j])) j++;
      const name = line.slice(i + 1, j);
      push('at', line.slice(i, j));
      preludeAt = 1;
      atDecl = CSS_DECL_AT.has(name.replace(/^-\w+-/, '')) ? 1 : 0;
      i = j;
      continue;
    }
    if (preludeAt) {
      // media/supports/layer preludes: keep it calm
      if (isDigit(c)) {
        let j = i + 1;
        while (j < n && /[\w.%]/.test(line[j])) j++;
        push('num', line.slice(i, j));
        i = j;
        continue;
      }
      if (isIdentStart(c)) {
        let j = i + 1;
        while (j < n && /[\w-]/.test(line[j])) j++;
        push(line[j] === ':' || line[j] === ')' ? 'prop' : '', line.slice(i, j));
        i = j;
        continue;
      }
      push('punc', c);
      i++;
      continue;
    }
    if (c === '.' || c === '#') {
      let j = i + 1;
      while (j < n && /[\w-]|\\./.test(line[j])) j += line[j] === '\\' ? 2 : 1;
      push('sel', line.slice(i, j));
      i = Math.max(j, i + 1);
      continue;
    }
    if (c === ':') {
      let j = i + 1;
      if (line[j] === ':') j++;
      while (j < n && /[\w-]/.test(line[j])) j++;
      push('fn', line.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(c) || c === '*' || c === '&') {
      let j = i + 1;
      while (j < n && /[\w-]/.test(line[j])) j++;
      push('tag', line.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && /[\w.%]/.test(line[j])) j++;
      push('num', line.slice(i, j));
      i = j;
      continue;
    }
    push('punc', c);
    i++;
  }
  return [out, pack()];
}

/* ------------------------------------------------------------------ HTML */

// state: bits0 comment | bit1 inTag | bits2-3 quote (1 = ', 2 = ") | bits4-5 raw (1 script, 2 style) | bits 8.. inner tokenizer state
export function tokenizeHtml(line, state = 0) {
  const out = [];
  const push = pusher(out);
  const n = line.length;
  let i = 0;
  let comment = state & 1;
  let inTag = (state >> 1) & 1;
  let quote = (state >> 2) & 3;
  let raw = (state >> 4) & 3;
  let inner = state >>> 8;
  let tagName = '';
  const pack = () => comment | (inTag << 1) | (quote << 2) | (raw << 4) | (inner << 8);

  while (i < n) {
    if (raw && !inTag) {
      const close = line.toLowerCase().indexOf(raw === 1 ? '</script' : '</style', i);
      const segEnd = close < 0 ? n : close;
      if (segEnd > i) {
        const [toks, next] = (raw === 1 ? tokenizeJs : tokenizeCss)(line.slice(i, segEnd), inner);
        for (const t of toks) push(t.t, t.v);
        inner = next;
      }
      i = segEnd;
      if (close >= 0) {
        raw = 0;
        inner = 0;
      } else break;
      continue;
    }
    if (comment) {
      const end = line.indexOf('-->', i);
      if (end < 0) {
        push('com', line.slice(i));
        return [out, pack()];
      }
      push('com', line.slice(i, end + 3));
      i = end + 3;
      comment = 0;
      continue;
    }
    if (inTag) {
      const c = line[i];
      if (quote) {
        const q = quote === 1 ? "'" : '"';
        const end = line.indexOf(q, i);
        if (end < 0) {
          push('str', line.slice(i));
          return [out, pack()];
        }
        push('str', line.slice(i, end + 1));
        i = end + 1;
        quote = 0;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c === "'" ? 1 : 2;
        push('str', c);
        i++;
        continue;
      }
      if (c === '>' || (c === '/' && line[i + 1] === '>')) {
        const len = c === '>' ? 1 : 2;
        push('punc', line.slice(i, i + len));
        i += len;
        inTag = 0;
        if (tagName === 'script') raw = 1;
        else if (tagName === 'style') raw = 2;
        if (raw) inner = 0;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n') {
        push('', c);
        i++;
        continue;
      }
      if (c === '=') {
        push('punc', c);
        i++;
        continue;
      }
      let j = i + 1;
      while (j < n && !/[\s=>"'/]/.test(line[j])) j++;
      push('attr', line.slice(i, j));
      i = j;
      continue;
    }
    const c = line[i];
    if (c === '<') {
      if (line.startsWith('<!--', i)) {
        comment = 1;
        push('com', '<!--');
        i += 4;
        continue;
      }
      let j = i + 1;
      if (line[j] === '/' || line[j] === '!') j++;
      const nameStart = j;
      while (j < n && /[\w:-]/.test(line[j])) j++;
      const name = line.slice(nameStart, j);
      push('punc', line.slice(i, nameStart));
      push('tag', name);
      tagName = line[i + 1] === '/' ? '' : name.toLowerCase();
      inTag = 1;
      i = j;
      continue;
    }
    let j = line.indexOf('<', i);
    if (j < 0) j = n;
    push('', line.slice(i, j));
    i = j;
  }
  return [out, pack()];
}

const TOKENIZERS = { css: tokenizeCss, js: tokenizeJs, html: tokenizeHtml };

/**
 * Lazily computes per-line start states and tokens. Lines longer than
 * MAX_HIGHLIGHT_LINE are rendered plain (minified bundles).
 */
export function createHighlighter(lang, lines) {
  const tokenize = TOKENIZERS[lang];
  const states = [0];
  const cache = new Map();

  function ensure(i) {
    while (states.length <= i && states.length - 1 < lines.length) {
      const k = states.length - 1;
      const text = lines[k];
      states.push(text.length > MAX_HIGHLIGHT_LINE || !tokenize ? states[k] : tokenize(text, states[k])[1]);
    }
  }

  return {
    tokens(i) {
      const hit = cache.get(i);
      if (hit) return hit;
      const text = lines[i];
      let toks;
      if (!tokenize || text.length > MAX_HIGHLIGHT_LINE) toks = [{ t: '', v: text }];
      else {
        ensure(i);
        toks = tokenize(text, states[i])[0];
      }
      if (cache.size > 600) cache.clear();
      cache.set(i, toks);
      return toks;
    },
  };
}
