/**
 * Selector Matcher — decides whether a CSS selector can ever match something in
 * the project. It never "removes" anything; it classifies:
 *
 *   used                      → static HTML or JS evidence supports every part
 *   unused / SAFE             → a required name exists nowhere (HTML or JS)
 *   unused / POTENTIAL        → names exist but never together, or only as a dynamic fragment
 *   unused / UNKNOWN          → a required name is missing, but the project has dynamic
 *                               writes we could not resolve, so absence is not proof
 *
 * Matching is compound-wise (each `tag.class#id[attr]` group is checked against the
 * element index). Combinators are not evaluated structurally on purpose: JavaScript
 * can re-parent nodes, so ancestry in the static HTML is not a reliable signal.
 */
import { CONFIDENCE } from '../utils/constants.js';
import { isLogicalPseudo } from '../parsers/selectorParser.js';
import { attrValueMatches } from './universe.js';

const ALWAYS_TAGS = new Set(['html', 'head', 'body']);

/**
 * @typedef {{ used: true, via: 'html'|'js'|'assumed'|'safelist', evidence?: string }
 *   | { used: false, confidence: 'SAFE'|'POTENTIAL'|'UNKNOWN', category: 'absent'|'pattern'|'structure', reasons: string[] }} SelectorResult
 */

/**
 * @param {{ text: string, compounds: any[] }} model
 * @param {import('./universe.js').Universe} uni
 * @returns {SelectorResult}
 */
export function evaluateSelector(model, uni) {
  // Safelist: any class/id named in it keeps the whole selector.
  if (uni.safelist.exact.size || uni.safelist.regex.length) {
    for (const c of model.compounds) {
      for (const p of c.parts) {
        if ((p.t === 'class' || p.t === 'id') && uni.isSafelisted(p.v)) return { used: true, via: 'safelist', evidence: `"${p.v}" is in your safelist` };
      }
    }
  }

  let via = 'html';
  let evidence;
  let soft = null; // first POTENTIAL finding (pattern / structure)
  for (const compound of model.compounds) {
    const r = evaluateCompound(compound.parts, uni);
    if (r.state === 'absent') return unusedAbsent(r.part, uni);
    if (r.state === 'pattern' || r.state === 'structure') {
      if (!soft) soft = r;
    } else if (r.via === 'js') {
      via = 'js';
      evidence = evidence || r.evidence;
    }
  }
  if (soft) {
    return { used: false, confidence: CONFIDENCE.POTENTIAL, category: soft.state, reasons: [soft.reason] };
  }
  return { used: true, via, evidence };
}

function evaluateCompound(parts, uni) {
  const reqs = [];
  let via = 'html';
  let evidence;
  let pattern = null;
  let soft = null;
  const js = (ev) => {
    via = 'js';
    evidence = evidence || ev;
  };

  for (const part of parts) {
    switch (part.t) {
      case 'tag': {
        const v = part.v;
        if (uni.tagIndex.has(v)) reqs.push(part);
        else if (ALWAYS_TAGS.has(v)) break;
        else if (uni.js.tags.has(v)) js(uni.js.tags.get(v));
        else return { state: 'absent', part };
        break;
      }
      case 'class': {
        const v = part.v;
        if (uni.classIndex.has(v)) reqs.push(part);
        else if (uni.js.classes.has(v)) js(uni.js.classes.get(v));
        else if (uni.js.words.has(v)) js(uni.js.words.get(v));
        else {
          const p = uni.matchPattern('class', v);
          if (p) pattern = pattern || { part, p };
          else return { state: 'absent', part };
        }
        break;
      }
      case 'id': {
        const v = part.v;
        if (uni.idIndex.has(v)) reqs.push(part);
        else if (uni.js.ids.has(v)) js(uni.js.ids.get(v));
        else if (uni.js.words.has(v)) js(uni.js.words.get(v));
        else {
          const p = uni.matchPattern('id', v);
          if (p) pattern = pattern || { part, p };
          else return { state: 'absent', part };
        }
        break;
      }
      case 'attr': {
        const r = evaluateAttr(part, uni);
        if (r === 'static') reqs.push(part);
        else if (r && r.via === 'js') js(r.evidence);
        else if (r && r.pattern) pattern = pattern || { part, p: r.pattern };
        else if (r && r.mismatch) soft = soft || `${describePart(part)}: the attribute exists in the HTML but none of its values match (values can change at runtime)`;
        else return { state: 'absent', part };
        break;
      }
      case 'pseudo': {
        if (part.inner && (isLogicalPseudo(part.name) || part.name === 'has')) {
          let anyUsed = false;
          let anySoft = null;
          for (const inner of part.inner) {
            const r = evaluateSelector(inner, uni);
            if (r.used) {
              anyUsed = true;
              if (r.via === 'js') js(r.evidence);
              break;
            }
            if (r.category !== 'absent' && !anySoft) anySoft = r;
          }
          if (!anyUsed) {
            if (anySoft) return { state: anySoft.category, reason: anySoft.reasons[0], part };
            return { state: 'absent', part: { t: 'pseudo-inner', v: `:${part.name}()` } };
          }
        }
        break; // :hover, :not(), :nth-child(), … cannot make a selector unmatchable on their own
      }
      default:
        break;
    }
  }

  if (reqs.length > 1 || reqs.some((r) => r.t === 'attr' && r.value !== null && r.op)) {
    if (!uni.coOccurs(reqs)) {
      return { state: 'structure', reason: `No element in the HTML has all of: ${describe(reqs)} (names exist separately)` };
    }
  }
  if (soft) return { state: 'structure', reason: soft };
  if (pattern) {
    return {
      state: 'pattern',
      reason: `${describePart(pattern.part)} may be generated dynamically (pattern "${pattern.p.source}" from ${pattern.p.ev})`,
    };
  }
  return { state: 'ok', via, evidence };
}

function evaluateAttr(part, uni) {
  const name = part.name;
  const hasValueTest = part.value !== null && part.value !== undefined && part.op;
  const staticList = uni.attrIndex.get(name);
  let mismatch = false;
  if (staticList) {
    if (!hasValueTest) return 'static';
    for (const idx of staticList) {
      const v = uni.elements[idx].attrs[name];
      if (attrValueMatches(v, part.op, part.value, part.flags)) return 'static';
    }
    mismatch = true;
  }
  // JavaScript may set the attribute / value.
  const vals = uni.js.attrValues.get(name);
  if (vals) {
    if (!hasValueTest) return { via: 'js', evidence: [...vals.values()][0] };
    for (const [v, ev] of vals) if (attrValueMatches(v, part.op, part.value, part.flags)) return { via: 'js', evidence: ev };
  }
  if (name === 'class' || name === 'id') {
    if (!hasValueTest) return { via: 'js', evidence: 'class/id assigned from JavaScript' };
    const source = name === 'class' ? [uni.js.classes, uni.js.words] : [uni.js.ids, uni.js.words];
    for (const m of source) {
      for (const [k, ev] of m) if (attrValueMatches(k, part.op, part.value, part.flags)) return { via: 'js', evidence: ev };
    }
    const needle = String(part.value);
    const p = uni.js.patterns.find((pt) => pt.source.includes(needle));
    if (p) return { pattern: p };
  }
  if (uni.js.attrs.has(name)) {
    if (!hasValueTest) return { via: 'js', evidence: uni.js.attrs.get(name) };
    // attribute is set from JS but with a value we cannot see
    return { pattern: { source: name, ev: uni.js.attrs.get(name) } };
  }
  if (!hasValueTest && uni.js.words.has(name)) return { via: 'js', evidence: uni.js.words.get(name) };
  const p = uni.matchPattern('attr', name);
  if (p) return { pattern: p };
  if (mismatch) return { mismatch: true };
  return null;
}

function unusedAbsent(part, uni) {
  const kind = part.t === 'pseudo-inner' ? 'class' : part.t;
  const label = describePart(part);
  const reasons = [];
  let confidence = CONFIDENCE.SAFE;
  const dyn = dynamicWrites(kind, uni);
  if (uni.incomplete.length) {
    confidence = CONFIDENCE.UNKNOWN;
    reasons.push(`${label} was not found, but the analysis is incomplete: ${uni.incomplete[0]}`);
  } else if (dyn.length) {
    confidence = CONFIDENCE.UNKNOWN;
    reasons.push(`${label} was not found, but JavaScript contains ${dyn.length} dynamic write${dyn.length === 1 ? '' : 's'} that could not be resolved (e.g. ${dyn[0]})`);
  } else {
    reasons.push(`${label} does not appear in any HTML file or JavaScript string`);
  }
  return { used: false, confidence, category: 'absent', reasons };
}

function dynamicWrites(kind, uni) {
  const u = uni.unresolved;
  switch (kind) {
    case 'class':
      return [...u.class, ...u.html];
    case 'id':
      return [...u.id, ...u.html];
    case 'tag':
      return [...u.tag, ...u.html];
    case 'attr':
      return [...u.attr, ...u.html];
    default:
      return u.html;
  }
}

function describePart(p) {
  switch (p.t) {
    case 'class':
      return `Class ".${p.v}"`;
    case 'id':
      return `ID "#${p.v}"`;
    case 'tag':
      return `Element <${p.v}>`;
    case 'attr':
      return `Attribute [${p.name}${p.op ? p.op + JSON.stringify(p.value) : ''}]`;
    default:
      return String(p.v ?? p.t);
  }
}

function describe(reqs) {
  return reqs.map((r) => (r.t === 'class' ? `.${r.v}` : r.t === 'id' ? `#${r.v}` : r.t === 'tag' ? r.v : `[${r.name}]`)).join('');
}
