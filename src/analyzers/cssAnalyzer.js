/**
 * CSS Analyzer — builds a compact structural model of a stylesheet from css-tree's AST:
 *
 *   rules (with every selector parsed into a matcher model and exact source ranges),
 *   container at-rules (@media/@supports/@container/@layer/@scope…), @keyframes,
 *   @font-face, @property, custom-property declarations, var() references,
 *   url() references and @import edges.
 *
 * It decides nothing about usage — that is the matcher's and the purifier's job.
 * The AST is discarded after this step, so large stylesheets don't stay in memory.
 */
import { generate, parseCss, walk } from '../parsers/cssParser.js';
import { selectorNodeToModel } from '../parsers/selectorParser.js';
import { buildLineIndex, offsetToLine } from '../utils/text.js';

const VENDOR = /^-(?:webkit|moz|o|ms)-/;
const KEEP_STATEMENTS = new Set(['charset', 'import', 'namespace']);
const CONTAINERS = new Set(['media', 'supports', 'container', 'document', 'scope', 'starting-style', 'layer']);

/**
 * @typedef {Object} DeclSummary
 * @property {Set<string>} varRefs     var(--x) used by regular declarations
 * @property {Set<string>} idents      identifiers & strings appearing in regular declaration values
 * @property {string[]} fonts          serialised font-family / font values
 * @property {{name:string,start:number,end:number,varRefs:Set<string>,idents:Set<string>,line:number}[]} customProps
 */

/**
 * @param {string} path
 * @param {string} text
 */
export function analyzeCss(path, text) {
  const lineStarts = buildLineIndex(text);
  const lineOf = (o) => offsetToLine(lineStarts, o);
  const { ast, errors, comments } = parseCss(text);

  const model = {
    path,
    size: text.length,
    parseErrors: errors,
    banners: comments.filter((c) => c.value.startsWith('!')).map((c) => text.slice(c.start, c.end)),
    children: [],
    imports: [],
    urls: [],
    selectorCount: 0,
    ruleCount: 0,
    ok: !!ast,
  };
  if (!ast) return model;

  let nodeSeq = 0;
  const nextId = (start) => `css:${path}@${start}#${nodeSeq++}`;

  const off = (n) => ({ start: n.loc.start.offset, end: n.loc.end.offset });

  function summarizeValue(valueNode, sink, isCustom) {
    if (!valueNode) return;
    if (valueNode.type === 'Raw') {
      // Unparsed value (error recovery): fall back to scanning the raw text.
      const raw = valueNode.value;
      for (const m of raw.matchAll(/var\(\s*(--[\w-]+)/g)) sink.varRefs.add(m[1]);
      for (const m of raw.matchAll(/[A-Za-z_][\w-]*/g)) sink.idents.add(m[0]);
      return;
    }
    walk(valueNode, (n) => {
      if (n.type === 'Function') {
        if (n.name.toLowerCase() === 'var') {
          const first = n.children && n.children.first;
          if (first && first.type === 'Identifier' && first.name.startsWith('--')) sink.varRefs.add(first.name);
        }
      } else if (n.type === 'Identifier') sink.idents.add(n.name);
      else if (n.type === 'String') sink.idents.add(n.value);
      else if (n.type === 'Url') {
        const url = typeof n.value === 'string' ? n.value : n.value && n.value.value;
        if (url && !isCustom) model.urls.push({ url, line: lineOf(n.loc.start.offset) });
      } else if (n.type === 'Raw') {
        for (const m of n.value.matchAll(/var\(\s*(--[\w-]+)/g)) sink.varRefs.add(m[1]);
      }
    });
  }

  /** @returns {DeclSummary} */
  function emptySummary() {
    return { varRefs: new Set(), idents: new Set(), fonts: [], customProps: [] };
  }

  function summarizeDeclaration(decl, summary) {
    const prop = decl.property;
    if (prop.startsWith('--')) {
      const entry = { name: prop, ...off(decl), varRefs: new Set(), idents: new Set(), line: lineOf(decl.loc.start.offset) };
      summarizeValue(decl.value, entry, true);
      entry.valueText = decl.value ? safeGenerate(decl.value).toLowerCase() : '';
      summary.customProps.push(entry);
      return;
    }
    summarizeValue(decl.value, summary, false);
    const lower = prop.toLowerCase();
    if ((lower === 'font-family' || lower === 'font') && decl.value) {
      try {
        summary.fonts.push(generate(decl.value));
      } catch {
        /* ignore */
      }
    }
  }

  function buildChildren(block, context, ownerSummary) {
    const children = [];
    if (!block || !block.children) return children;
    for (const child of block.children.toArray()) {
      switch (child.type) {
        case 'Rule': {
          const n = buildRule(child, context);
          if (n) children.push(n);
          break;
        }
        case 'Atrule': {
          const n = buildAtrule(child, context);
          if (n) children.push(n);
          break;
        }
        case 'Declaration':
          if (ownerSummary) {
            summarizeDeclaration(child, ownerSummary);
            ownerSummary.hasDeclarations = true;
          }
          break;
        case 'Raw': {
          // css-tree only understands nested rules that start with "&"; re-parse the others.
          const nested = child.value.includes('{') ? parseNestedFragment(child, context) : null;
          if (nested) children.push(...nested);
          else children.push({ kind: 'raw', id: nextId(child.loc.start.offset), ...off(child), line: lineOf(child.loc.start.offset) });
          break;
        }
        default:
          break;
      }
    }
    return children;
  }

  function parseNestedFragment(raw, context) {
    const { ast: frag } = parseCss(raw.value, { offset: raw.loc.start.offset, line: raw.loc.start.line, column: raw.loc.start.column });
    if (!frag) return null;
    const out = [];
    let rules = 0;
    for (const c of frag.children.toArray()) {
      if (c.type === 'Rule') {
        const n = buildRule(c, context);
        if (n) {
          out.push(n);
          if (n.kind === 'rule') rules++;
        }
      } else if (c.type === 'Atrule') {
        const n = buildAtrule(c, context);
        if (n) out.push(n);
        rules++;
      } else if (c.type === 'Raw') out.push({ kind: 'raw', id: nextId(c.loc.start.offset), ...off(c), line: lineOf(c.loc.start.offset) });
    }
    return rules ? out : null;
  }

  function buildRule(node, context) {
    const range = off(node);
    if (!node.prelude || node.prelude.type !== 'SelectorList') {
      return { kind: 'raw', id: nextId(range.start), ...range, line: lineOf(range.start) };
    }
    model.ruleCount++;
    const selectors = [];
    for (const s of node.prelude.children.toArray()) {
      if (s.type !== 'Selector') continue;
      const sr = off(s);
      let selModel;
      try {
        selModel = selectorNodeToModel(s);
      } catch {
        selModel = { text: text.slice(sr.start, sr.end), compounds: [] };
      }
      selectors.push({ ...sr, text: selModel.text, model: selModel, line: lineOf(sr.start) });
      model.selectorCount++;
    }
    const decls = emptySummary();
    const children = buildChildren(node.block, context, decls);
    const prelude = off(node.prelude);
    return {
      kind: 'rule',
      id: nextId(range.start),
      ...range,
      line: lineOf(range.start),
      selectors,
      selStart: prelude.start,
      selEnd: prelude.end,
      decls,
      children,
      context,
    };
  }

  function buildAtrule(node, context) {
    const range = off(node);
    const name = node.name.toLowerCase();
    const bare = name.replace(VENDOR, '');
    const base = { id: nextId(range.start), ...range, line: lineOf(range.start), name, context };
    const preludeText = node.prelude ? safeGenerate(node.prelude) : '';

    if (KEEP_STATEMENTS.has(bare)) {
      if (bare === 'import' && node.prelude) {
        walk(node.prelude, (n) => {
          if (n.type === 'Url') model.imports.push({ url: typeof n.value === 'string' ? n.value : n.value?.value, line: base.line });
          else if (n.type === 'String') model.imports.push({ url: n.value, line: base.line });
        });
      }
      return { kind: 'keep', ...base, prelude: preludeText };
    }

    if (bare === 'keyframes') {
      const decls = emptySummary();
      if (node.block) {
        for (const frame of node.block.children.toArray()) {
          if (frame.type === 'Rule' && frame.block) {
            for (const d of frame.block.children.toArray()) if (d.type === 'Declaration') summarizeDeclaration(d, decls);
          }
        }
      }
      return { kind: 'keyframes', ...base, keyframesName: preludeText.replace(/^["']|["']$/g, ''), decls };
    }

    if (bare === 'font-face') {
      const decls = emptySummary();
      let family = '';
      if (node.block) {
        for (const d of node.block.children.toArray()) {
          if (d.type !== 'Declaration') continue;
          summarizeDeclaration(d, decls);
          if (d.property.toLowerCase() === 'font-family' && d.value) family = safeGenerate(d.value).replace(/^["']|["']$/g, '');
        }
      }
      return { kind: 'font-face', ...base, family: family.trim(), decls };
    }

    if (bare === 'property') {
      const decls = emptySummary();
      if (node.block) for (const d of node.block.children.toArray()) if (d.type === 'Declaration') summarizeDeclaration(d, decls);
      return { kind: 'property', ...base, propertyName: preludeText.trim(), decls };
    }

    if (bare === 'layer' && !node.block) {
      return { kind: 'layer-statement', ...base, names: preludeText.split(',').map((s) => s.trim()).filter(Boolean) };
    }

    if (CONTAINERS.has(bare) && node.block) {
      const label = `@${node.name}${preludeText ? ' ' + preludeText : ''}`;
      const decls = emptySummary();
      const children = buildChildren(node.block, [...context, label], decls);
      return {
        kind: 'container',
        ...base,
        label,
        bare,
        layerName: bare === 'layer' ? preludeText.trim() : null,
        decls,
        children,
        hasDeclarations: !!decls.hasDeclarations,
      };
    }

    // @page, @counter-style, @font-feature-values, @view-transition, unknown at-rules: leave untouched.
    return { kind: 'keep', ...base, prelude: preludeText };
  }

  model.children = buildChildren(ast, [], null);
  return model;
}

function safeGenerate(node) {
  try {
    return generate(node);
  } catch {
    return '';
  }
}

/** Depth-first iteration over every node of the model. */
export function walkCssModel(children, visit, parent = null) {
  for (const n of children) {
    visit(n, parent);
    if (n.children) walkCssModel(n.children, visit, n);
  }
}
