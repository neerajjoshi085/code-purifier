/**
 * Selector Parser — turns css-tree selector nodes (or raw selector strings found
 * in JavaScript) into a small normalised model the matcher can reason about:
 *
 *   Selector := { text, compounds: Compound[] }
 *   Compound := { combinator: ' ' | '>' | '+' | '~' | null, parts: Part[] }
 *   Part     := tag | universal | class | id | attr | pseudo | pseudo-element | nesting
 */
import selectorParse from 'css-tree/selector-parser';
import { generate } from './cssParser.js';

const LOGICAL_PSEUDOS = new Set(['is', 'where', 'matches', '-webkit-any', '-moz-any', 'any']);

/**
 * @param {any} selectorNode css-tree `Selector` node
 */
export function selectorNodeToModel(selectorNode) {
  const compounds = [];
  let current = { combinator: null, parts: [] };
  const flush = () => {
    if (current.parts.length) compounds.push(current);
  };

  for (const child of selectorNode.children.toArray()) {
    switch (child.type) {
      case 'Combinator': {
        flush();
        const name = child.name.trim();
        current = { combinator: name === '' ? ' ' : name === '>>>' || name === '/deep/' ? ' ' : name, parts: [] };
        break;
      }
      case 'TypeSelector': {
        const raw = child.name;
        const name = raw.includes('|') ? raw.slice(raw.indexOf('|') + 1) : raw;
        if (name === '*') current.parts.push({ t: 'universal' });
        else current.parts.push({ t: 'tag', v: name.toLowerCase() });
        break;
      }
      case 'ClassSelector':
        current.parts.push({ t: 'class', v: child.name });
        break;
      case 'IdSelector':
        current.parts.push({ t: 'id', v: child.name });
        break;
      case 'AttributeSelector': {
        const value = child.value ? (child.value.value ?? child.value.name ?? null) : null;
        current.parts.push({
          t: 'attr',
          name: String(child.name.name).toLowerCase(),
          op: child.matcher || null,
          value,
          flags: child.flags || null,
        });
        break;
      }
      case 'PseudoClassSelector': {
        const name = child.name.toLowerCase();
        const part = { t: 'pseudo', name, inner: null };
        if (child.children) {
          const inner = [];
          for (const c of child.children.toArray()) {
            if (c.type === 'SelectorList') {
              for (const s of c.children.toArray()) {
                if (s.type === 'Selector') inner.push(selectorNodeToModel(s));
              }
            } else if (c.type === 'Selector') {
              inner.push(selectorNodeToModel(c));
            }
          }
          if (inner.length) part.inner = inner;
        }
        current.parts.push(part);
        break;
      }
      case 'PseudoElementSelector':
        current.parts.push({ t: 'pseudo-element', name: child.name.toLowerCase() });
        break;
      case 'NestingSelector':
        current.parts.push({ t: 'nesting' });
        break;
      default:
        // Nth, Percentage, Raw, WhiteSpace… carry no matching information.
        break;
    }
  }
  flush();
  return { text: generate(selectorNode), compounds };
}

export function isLogicalPseudo(name) {
  return LOGICAL_PSEUDOS.has(name);
}

/**
 * Parses a selector string coming from JavaScript (querySelector('.a > b'), …).
 * Returns models or null if it is not a valid selector list.
 * @returns {ReturnType<typeof selectorNodeToModel>[] | null}
 */
export function parseSelectorString(str) {
  const trimmed = str.trim();
  if (!trimmed || trimmed.length > 500) return null;
  try {
    let bad = false;
    const ast = selectorParse(trimmed, {
      context: 'selectorList',
      onParseError() {
        bad = true;
      },
    });
    if (bad || !ast || !ast.children) return null;
    const out = [];
    for (const s of ast.children.toArray()) {
      if (s.type === 'Selector') out.push(selectorNodeToModel(s));
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Flattens a selector model into the individual names it requires.
 * Used to turn DOM query strings found in JS into usage evidence.
 */
export function collectSelectorTokens(models) {
  const tokens = { classes: new Set(), ids: new Set(), tags: new Set(), attrs: new Set() };
  const visit = (model) => {
    for (const comp of model.compounds) {
      for (const p of comp.parts) {
        if (p.t === 'class') tokens.classes.add(p.v);
        else if (p.t === 'id') tokens.ids.add(p.v);
        else if (p.t === 'tag') tokens.tags.add(p.v);
        else if (p.t === 'attr') tokens.attrs.add(p.name);
        else if (p.t === 'pseudo' && p.inner) p.inner.forEach(visit);
      }
    }
  };
  models.forEach(visit);
  return tokens;
}
