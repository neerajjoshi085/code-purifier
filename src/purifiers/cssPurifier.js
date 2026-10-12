/**
 * CSS Purifier.
 *
 * Works on all stylesheets of a project at once, because custom properties,
 * @keyframes and @font-face are referenced across files.
 *
 *   1. judge every selector (selectorMatcher) and decide rule fates under the options
 *   2. compute reachability: which custom properties / keyframes / fonts are referenced
 *      by the rules that survive (fixed point — a variable used only by a removed rule is unused)
 *   3. collapse empty containers (@media/@supports/@container/@layer…)
 *   4. emit range edits against the original text → purified text (source order, comments,
 *      hacks and formatting untouched), then optionally minify
 *
 * Every removal carries a confidence; nothing below the allowed confidence is touched.
 */
import { CONFIDENCE, CONFIDENCE_RANK, STATUS, statusForConfidence, weakestConfidence } from '../utils/constants.js';
import { applyEdits, expandRemovalRange, removedLineCount } from '../utils/edits.js';
import { buildLineIndex, byteLength, offsetToLine, truncate } from '../utils/text.js';
import { evaluateSelector } from '../analyzers/selectorMatcher.js';
import { generateCss, parseCss } from '../parsers/cssParser.js';

const MAX_LISTED_USED = 2000;

/**
 * @param {{ files: { model: any, text: string }[], universe: import('../analyzers/universe.js').Universe, options: any }} input
 * @returns {Map<string, any>}
 */
export function purifyCssFiles({ files, universe, options }) {
  const overrides = options.overrides || {};
  universe.setSafelist(options.safelist);
  const safelistKey = (options.safelist || []).join('\n');
  const incomplete = universe.incomplete.length > 0 || universe.unresolved.style.length > 0;

  // CSS out of scope (the JS page): nothing in a stylesheet is touched, not even a manual
  // "remove" left over from the CSS page.
  const cssInScope = !!options.removeUnusedCss;

  function allow(confidence, id) {
    if (!cssInScope) return false;
    const ov = overrides[id];
    if (ov === 'keep') return false;
    if (ov === 'remove') return true;
    if (confidence === CONFIDENCE.SAFE) return !!options.removeUnusedCss;
    return !!options.removePotentialCss;
  }

  // The models are cached between runs (the worker re-purifies the same analysis when options
  // or the page change). Clear every per-run decision first: a node that is kept this run is
  // not always re-decided (e.g. a used @keyframes), so a stale 'remove' would otherwise leak in.
  for (const f of files) resetFates(f.model.children);

  /* ------------------------------------------------------------ 1. selector fates */

  const states = files.map((f) => ({
    ...f,
    path: f.model.path,
    findings: [],
    usedSelectors: [],
    counts: { selectors: 0, used: 0, unusedSafe: 0, unusedPotential: 0, unusedUnknown: 0, keyframes: 0, keyframesUnused: 0, fonts: 0, fontsUnused: 0, vars: 0, varsUnused: 0, properties: 0 },
    keyframes: [],
    fontFaces: [],
    properties: [],
    keptRules: [],
    keptContainers: [],
    removedSafeBytes: 0,
  }));

  function judgeRules(state, children) {
    for (const n of children) {
      if (n.kind === 'rule') {
        decideRule(state, n);
        if (n.fate !== 'remove') {
          state.keptRules.push(n);
          judgeRules(state, n.children);
        }
      } else if (n.kind === 'container') {
        state.keptContainers.push(n);
        judgeRules(state, n.children);
      } else if (n.kind === 'keyframes') state.keyframes.push(n);
      else if (n.kind === 'font-face') state.fontFaces.push(n);
      else if (n.kind === 'property') state.properties.push(n);
    }
  }

  function decideRule(state, rule) {
    const { counts, findings } = state;
    const sels = rule.selectors;
    let unused = 0;
    let weakest = CONFIDENCE.SAFE;
    const reasons = [];
    for (let i = 0; i < sels.length; i++) {
      const s = sels[i];
      s.id = `${rule.id}:s${i}`;
      if (s._rk !== safelistKey) {
        s._r = evaluateSelector(s.model, universe);
        s._rk = safelistKey;
      }
      const r = s._r;
      counts.selectors++;
      if (r.used) {
        counts.used++;
        if (state.usedSelectors.length < MAX_LISTED_USED) state.usedSelectors.push(s.text);
      } else {
        unused++;
        weakest = weakestConfidence(weakest, r.confidence);
        if (r.confidence === CONFIDENCE.SAFE) counts.unusedSafe++;
        else if (r.confidence === CONFIDENCE.POTENTIAL) counts.unusedPotential++;
        else counts.unusedUnknown++;
        for (const x of r.reasons) if (!reasons.includes(x) && reasons.length < 3) reasons.push(x);
      }
    }
    rule.unusedCount = unused;
    rule.fate = 'keep';
    if (!sels.length || rule.kind !== 'rule') return;
    const ov = overrides[rule.id];
    const ctxLabel = rule.context.length ? rule.context.join(' › ') : null;
    const ruleText = truncate(sels.map((s) => s.text).join(', '), 110);

    if (unused === sels.length) {
      const removeRule = cssInScope && (ov === 'remove' || (ov !== 'keep' && allow(weakest, rule.id)));
      if (removeRule) rule.fate = 'remove';
      else if (ov !== 'keep') {
        // prune individually removable selectors (e.g. SAFE ones inside a POTENTIAL rule)
        const keepIdx = [];
        for (let i = 0; i < sels.length; i++) if (!allow(sels[i]._r.confidence, sels[i].id)) keepIdx.push(i);
        if (keepIdx.length === 0) rule.fate = 'remove';
        else if (keepIdx.length < sels.length) {
          rule.fate = 'prune';
          rule.keepIdx = keepIdx;
        }
      }
      rule.removalConfidence = weakest;
      const bytes = byteLength(state.text.slice(rule.start, rule.end));
      findings.push(makeFinding(state, rule, {
        id: rule.id,
        kind: 'rule',
        name: ruleText,
        confidence: weakest,
        reasons,
        start: rule.start,
        end: rule.end,
        bytes,
        removed: rule.fate === 'remove',
        context: ctxLabel,
      }));
      if (rule.fate === 'prune') {
        // transparency: also report the pruned selectors
        for (let i = 0; i < sels.length; i++) {
          if (rule.keepIdx.includes(i)) continue;
          pushSelectorFinding(state, rule, sels[i], ctxLabel, true);
        }
      }
      return;
    }

    if (unused > 0) {
      const keepIdx = [];
      const prunedFlags = [];
      for (let i = 0; i < sels.length; i++) {
        const s = sels[i];
        const removable = !s._r.used && ov !== 'keep' && allow(s._r.confidence, s.id);
        prunedFlags.push(removable);
        if (!removable) keepIdx.push(i);
      }
      if (keepIdx.length < sels.length) {
        rule.fate = 'prune';
        rule.keepIdx = keepIdx;
      }
      for (let i = 0; i < sels.length; i++) {
        if (!sels[i]._r.used) pushSelectorFinding(state, rule, sels[i], ctxLabel, prunedFlags[i]);
      }
    }
  }

  function pushSelectorFinding(state, rule, sel, ctxLabel, removed) {
    const r = sel._r;
    state.findings.push(makeFinding(state, rule, {
      id: sel.id,
      kind: 'selector',
      name: truncate(sel.text, 110),
      confidence: r.confidence,
      reasons: r.reasons,
      start: sel.start,
      end: sel.end,
      bytes: sel.end - sel.start + 2,
      removed,
      context: ctxLabel,
    }));
  }

  for (const st of states) judgeRules(st, st.model.children);

  /* ------------------------------------------------------------ 2. reachability */

  const usedVars = new Set(universe.js.varNames);
  for (const s of universe.styleAttrs) for (const m of s.matchAll(/--[A-Za-z_][\w-]*/g)) usedVars.add(m[0]);
  const idents = new Set();
  const identsLower = new Set();
  const fontBlobParts = [];
  const styleAttrText = universe.styleAttrs.join('\n').toLowerCase();
  for (const s of universe.styleAttrs) for (const m of s.matchAll(/[A-Za-z_][\w-]*/g)) idents.add(m[0]);

  const pendingProps = []; // custom properties of kept rules
  const addDecls = (d) => {
    for (const v of d.varRefs) usedVars.add(v);
    for (const i of d.idents) idents.add(i);
    for (const f of d.fonts) fontBlobParts.push(f.toLowerCase());
  };

  for (const st of states) {
    for (const rule of st.keptRules) {
      addDecls(rule.decls);
      for (const cp of rule.decls.customProps) {
        pendingProps.push({ cp, rule, state: st });
        for (const i of cp.idents) idents.add(i);
        fontBlobParts.push(cp.valueText);
      }
    }
    for (const c of st.keptContainers) {
      addDecls(c.decls);
      for (const cp of c.decls.customProps) {
        pendingProps.push({ cp, rule: c, state: st });
        for (const i of cp.idents) idents.add(i);
        fontBlobParts.push(cp.valueText);
      }
      for (const m of c.label.matchAll(/--[A-Za-z_][\w-]*/g)) usedVars.add(m[0]); // @container style(--x: 1)
    }
  }

  const wordUsed = (name) => idents.has(name) || universe.js.words.has(name) || universe.htmlWords.has(name);
  let fontBlob = '';
  const fontUsed = (family) => {
    const f = family.toLowerCase();
    return !!f && (fontBlob.includes(f) || universe.stringBlob.includes(f) || styleAttrText.includes(f) || idents.has(family));
  };
  const absentConfidence = incomplete ? CONFIDENCE.UNKNOWN : CONFIDENCE.SAFE;

  const keptKeyframes = new Set();
  const keptFonts = new Set();
  const keptProps = new Set();
  const activeProps = new Set();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    fontBlob = fontBlobParts.join('\n');
    for (const st of states) {
      for (const k of st.keyframes) {
        if (keptKeyframes.has(k)) continue;
        if (wordUsed(k.keyframesName)) {
          keptKeyframes.add(k);
          addDecls(k.decls);
          changed = true;
        }
      }
      for (const f of st.fontFaces) {
        if (keptFonts.has(f)) continue;
        if (fontUsed(f.family)) {
          keptFonts.add(f);
          addDecls(f.decls);
          changed = true;
        }
      }
      for (const p of st.properties) {
        if (keptProps.has(p)) continue;
        if (usedVars.has(p.propertyName)) {
          keptProps.add(p);
          addDecls(p.decls);
          changed = true;
        }
      }
    }
    for (const entry of pendingProps) {
      if (activeProps.has(entry.cp)) continue;
      if (usedVars.has(entry.cp.name)) {
        activeProps.add(entry.cp);
        for (const v of entry.cp.varRefs) usedVars.add(v);
        for (const i of entry.cp.idents) idents.add(i);
        changed = true;
      }
    }
  }

  // Fates of at-rules and custom properties.
  for (const st of states) {
    const { counts, findings } = st;
    for (const k of st.keyframes) {
      counts.keyframes++;
      if (keptKeyframes.has(k)) continue;
      counts.keyframesUnused++;
      decideSimple(st, k, 'keyframes', `@keyframes ${k.keyframesName}`, absentConfidence, `Animation "${k.keyframesName}" is not referenced by any surviving animation property`);
    }
    for (const f of st.fontFaces) {
      counts.fonts++;
      if (keptFonts.has(f)) continue;
      counts.fontsUnused++;
      decideSimple(st, f, 'font-face', `@font-face ${f.family || '(unnamed)'}`, absentConfidence, `Font family "${f.family}" is not used by any surviving font-family/font declaration`);
    }
    for (const p of st.properties) {
      counts.properties++;
      if (keptProps.has(p)) continue;
      decideSimple(st, p, 'property', `@property ${p.propertyName}`, incomplete ? CONFIDENCE.UNKNOWN : CONFIDENCE.POTENTIAL, `Registered property ${p.propertyName} is never read with var()`);
    }
    for (const rule of [...st.keptRules, ...st.keptContainers]) {
      rule.removedProps = [];
      for (const cp of rule.decls.customProps) {
        counts.vars++;
        if (activeProps.has(cp)) continue;
        counts.varsUnused++;
        const id = `${rule.id}:var:${cp.name}:${cp.start}`;
        const conf = incomplete ? CONFIDENCE.UNKNOWN : CONFIDENCE.POTENTIAL;
        const remove = allow(conf, id);
        if (remove) rule.removedProps.push(cp);
        findings.push(makeFinding(st, rule, {
          id,
          kind: 'custom-property',
          name: cp.name,
          confidence: conf,
          reasons: [`${cp.name} is never read with var(); custom properties can also be read from JavaScript or other stylesheets`],
          start: cp.start,
          end: cp.end,
          bytes: cp.end - cp.start + 1,
          removed: remove,
          context: rule.kind === 'rule' ? truncate(rule.selectors.map((s) => s.text).join(', '), 60) : rule.label,
        }));
      }
    }
  }

  function decideSimple(st, node, kind, name, confidence, reason) {
    const remove = allow(confidence, node.id);
    node.fate = remove ? 'remove' : 'keep';
    node.removalConfidence = confidence;
    st.findings.push(makeFinding(st, node, {
      id: node.id,
      kind,
      name,
      confidence,
      reasons: [reason],
      start: node.start,
      end: node.end,
      bytes: byteLength(st.text.slice(node.start, node.end)),
      removed: remove,
      context: node.context.length ? node.context.join(' › ') : null,
    }));
  }

  /* ------------------------------------------------------------ 3. containers */

  for (const st of states) {
    const seenLayers = new Set();
    collapse(st, st.model.children, '', seenLayers);
  }

  function collapse(st, children, layerPrefix, seenLayers) {
    let allRemoved = true;
    let weakest = CONFIDENCE.SAFE;
    for (const n of children) {
      if (n.kind === 'container') {
        const qualified = n.layerName ? (layerPrefix ? `${layerPrefix}.${n.layerName}` : n.layerName) : null;
        const sub = collapse(st, n.children, qualified || layerPrefix, seenLayers);
        if (!n.hasDeclarations && sub.allRemoved) {
          n.removalConfidence = sub.weakest;
          if (qualified) {
            if (!seenLayers.has(qualified)) {
              n.fate = 'layer-statement'; // keep the layer's position in the cascade order
              seenLayers.add(qualified);
              allRemoved = false;
              continue;
            }
          }
          n.fate = 'remove';
          weakest = weakestConfidence(weakest, sub.weakest);
        } else {
          n.fate = 'keep';
          if (qualified) seenLayers.add(qualified);
          allRemoved = false;
        }
      } else if (n.kind === 'layer-statement') {
        for (const name of n.names) seenLayers.add(layerPrefix ? `${layerPrefix}.${name}` : name);
        allRemoved = false;
      } else if (n.fate === 'remove') {
        weakest = weakestConfidence(weakest, n.removalConfidence || CONFIDENCE.SAFE);
      } else {
        allRemoved = false;
      }
    }
    return { allRemoved: allRemoved && children.length > 0, weakest };
  }

  /* ------------------------------------------------------------ 4. edits + output */

  const results = new Map();
  for (const st of states) {
    const { model, text } = st;
    const edits = [];

    const emit = (children) => {
      for (const n of children) {
        if (n.fate === 'remove') {
          const r = expandRemovalRange(text, n.start, n.end);
          edits.push({ ...r, replacement: '', meta: { id: n.id, confidence: n.removalConfidence || CONFIDENCE.SAFE } });
          continue;
        }
        if (n.fate === 'layer-statement') {
          const r = expandRemovalRange(text, n.start, n.end);
          edits.push({ ...r, replacement: `@layer ${n.layerName};\n`, meta: { id: n.id, confidence: n.removalConfidence || CONFIDENCE.SAFE } });
          continue;
        }
        if (n.kind === 'rule') {
          if (n.fate === 'prune') {
            const kept = n.keepIdx.map((i) => n.selectors[i].text);
            const sep = n.selectors.length > 1 ? text.slice(n.selectors[0].end, n.selectors[1].start) : ', ';
            edits.push({ start: n.selStart, end: n.selEnd, replacement: kept.join(/,/.test(sep) ? sep : ', '), meta: { id: n.id, confidence: CONFIDENCE.SAFE, partial: true } });
          }
          emitProps(n);
          emit(n.children);
        } else if (n.kind === 'container') {
          emitProps(n);
          emit(n.children);
        }
      }
    };
    const emitProps = (n) => {
      for (const cp of n.removedProps || []) {
        let end = cp.end;
        while (end < text.length && /\s/.test(text[end]) && text[end] !== '\n') end++;
        if (text[end] === ';') end++;
        const r = expandRemovalRange(text, cp.start, end);
        edits.push({ ...r, replacement: '', meta: { id: `${n.id}:var:${cp.name}:${cp.start}`, confidence: CONFIDENCE.POTENTIAL } });
      }
    };
    emit(model.children);

    let applied = applyEdits(text, edits);
    let output = applied.text;
    const notes = [];
    if (edits.length) {
      const before = model.parseErrors.length;
      const after = parseCss(output).errors.length;
      if (after > before) {
        notes.push('The purified CSS produced new parse errors, so this file was left unchanged.');
        applied = { text, removed: [], changed: [] };
        output = text;
        for (const f of st.findings) f.removed = false;
      }
    }

    let final = output;
    let minified = false;
    if (options.minifyCss) {
      const m = minifyCss(output);
      if (m.ok) {
        final = m.text;
        minified = true;
      } else notes.push(`Minification skipped: ${m.error}`);
    }

    const lineStarts = buildLineIndex(text);
    const outLineStarts = buildLineIndex(output);
    const removedRanges = applied.removed.map((r) => ({
      startLine: offsetToLine(lineStarts, r.start),
      endLine: offsetToLine(lineStarts, Math.max(r.start, r.end - 1)),
      id: r.meta?.id,
      confidence: r.meta?.confidence,
      bytes: r.end - r.start,
      lines: removedLineCount(lineStarts, r.start, r.end, text.length),
    }));
    const changedRanges = applied.changed.map((r) => ({
      startLine: offsetToLine(outLineStarts, r.start),
      endLine: offsetToLine(outLineStarts, Math.max(r.start, r.end - 1)),
    }));

    // Line numbers for findings
    for (const f of st.findings) {
      f.startLine = offsetToLine(lineStarts, f.start);
      f.endLine = offsetToLine(lineStarts, Math.max(f.start, f.end - 1));
    }
    const flaggedBytes = sumDisjoint(st.findings.filter((f) => !f.removed && f.kind !== 'custom-property'));
    const potentialBytes = sumDisjoint(st.findings.filter((f) => f.confidence !== CONFIDENCE.SAFE && !f.removed && f.kind !== 'custom-property'));

    results.set(st.path, {
      path: st.path,
      lang: 'css',
      output,
      final,
      minified,
      notes,
      findings: st.findings,
      usedSelectors: st.usedSelectors,
      counts: st.counts,
      removedRanges,
      changedRanges,
      bytes: { original: byteLength(text), purified: byteLength(output), final: byteLength(final) },
      flaggedBytes,
      potentialBytes,
      parseErrors: model.parseErrors,
    });
  }
  return results;
}

function resetFates(children) {
  if (!children) return;
  for (const n of children) {
    n.fate = undefined;
    n.keepIdx = undefined;
    n.removedProps = undefined;
    n.removalConfidence = undefined;
    resetFates(n.children);
  }
}

function makeFinding(state, node, f) {
  return {
    file: state.path,
    lang: 'css',
    status: statusForConfidence(f.confidence),
    ...f,
  };
}

function sumDisjoint(findings) {
  const sorted = [...findings].filter((f) => f.kind !== 'selector' || true).sort((a, b) => a.start - b.start || b.end - a.end);
  let total = 0;
  let cursor = -1;
  for (const f of sorted) {
    if (f.end <= cursor) continue;
    const s = Math.max(f.start, cursor);
    total += f.bytes * ((f.end - s) / Math.max(1, f.end - f.start));
    cursor = f.end;
  }
  return Math.round(total);
}

/** Whitespace/comment-free serialisation; preserves rule order, @media, hacks, and /*! banners. */
export function minifyCss(text) {
  try {
    const { ast, errors } = parseCss(text);
    if (!ast) return { ok: false, error: 'could not parse' };
    const out = generateCss(ast);
    if (errors.length && out.length < text.length * 0.2) return { ok: false, error: 'stylesheet has syntax errors' };
    return { ok: true, text: out };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export { CONFIDENCE_RANK, STATUS };
