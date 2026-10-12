/**
 * JavaScript Purifier.
 *
 * Removes only what the analyzer classified as SAFE (plus anything the user explicitly
 * overrides). The liveness solver is re-run for the chosen policy so cascades are
 * handled: removing a dead function also frees the helpers only it used.
 *
 * Output is produced by splicing the original text (comments, formatting and execution
 * order are untouched), then re-parsed as a safety net; if the result does not parse the
 * file is returned unchanged. Minification (terser) is a separate, optional step.
 */
import { CONFIDENCE, STATUS } from '../utils/constants.js';
import { applyEdits, expandRemovalRange, removedLineCount } from '../utils/edits.js';
import { buildLineIndex, byteLength, offsetToLine } from '../utils/text.js';
import { parseJs } from '../parsers/jsParser.js';

const LICENSE_COMMENT = /^!|@license|@preserve|@copyright|@cc_on/i;

/**
 * @param {{ project: any, options: any }} input
 * @returns {Promise<Map<string, any>>}
 */
export async function purifyJsFiles({ project, options }) {
  const overrides = options.overrides || {};
  // JS out of scope (the CSS page): no script is touched, not even a manual "remove" left over
  // from the JS page.
  const eligible = (c) => {
    if (!options.removeUnusedJs) return false;
    const ov = overrides[c.id];
    if (ov === 'keep') return false;
    if (!c.removable && ov !== 'remove') return false;
    if (ov === 'remove') return c.removable;
    return !!options.removeUnusedJs && c.safeAble;
  };
  const live = project.solve(eligible);
  const removedSet = new Set(project.candidates.filter((c) => eligible(c) && !live.has(c)));

  const results = new Map();
  for (const ctx of project.ok) {
    results.set(ctx.path, await purifyOne(ctx, removedSet, options));
  }
  return results;
}

async function purifyOne(ctx, removedSet, options) {
  const { text } = ctx;
  const cands = ctx.candidates;
  const edits = [];
  const notes = [];

  const declGroups = new Map();
  const importGroups = new Map();

  for (const c of cands) {
    if (!removedSet.has(c)) continue;
    switch (c.removal.type) {
      case 'declarator': {
        const g = c.removal.group;
        if (!declGroups.has(g)) declGroups.set(g, []);
        declGroups.get(g).push(c);
        break;
      }
      case 'import-specifier': {
        const g = c.removal.group;
        if (!importGroups.has(g)) importGroups.set(g, []);
        importGroups.get(g).push(c);
        break;
      }
      default:
        if (c.kind === 'dead-code') edits.push(deadEdit(ctx, c));
        else edits.push(statementEdit(ctx, c.start, c.end, { id: c.id, confidence: c.confidence || CONFIDENCE.SAFE }));
    }
  }

  for (const [g, removed] of declGroups) {
    const kept = g.declarators.filter((d) => !removedSet.has(d.cand));
    const meta = { id: removed[0].id, confidence: removed[0].confidence || CONFIDENCE.SAFE };
    if (kept.length === 0) {
      edits.push(statementEdit(ctx, g.start, g.end, meta));
    } else {
      const first = g.declarators[0];
      const last = g.declarators[g.declarators.length - 1];
      const replacement = text.slice(g.start, first.start) + kept.map((d) => text.slice(d.start, d.end)).join(', ') + text.slice(last.end, g.end);
      edits.push({ start: g.start, end: g.end, replacement, meta });
    }
  }

  for (const [g, removed] of importGroups) {
    const kept = g.specs.filter((s) => !removedSet.has(s.cand));
    const meta = { id: removed[0].id, confidence: removed[0].confidence || CONFIDENCE.SAFE };
    let replacement;
    if (kept.length === 0) replacement = `import ${g.sourceRaw}${g.tail}`; // keep the module's side effects
    else {
      const clauses = [];
      const def = kept.find((s) => s.kind === 'default');
      const ns = kept.find((s) => s.kind === 'namespace');
      const named = kept.filter((s) => s.kind === 'named');
      if (def) clauses.push(def.text);
      if (ns) clauses.push(ns.text);
      if (named.length) clauses.push(`{ ${named.map((s) => s.text).join(', ')} }`);
      replacement = `import ${clauses.join(', ')} from ${g.sourceRaw}${g.tail}`;
    }
    edits.push({ start: g.start, end: g.end, replacement, meta });
  }

  let applied = applyEdits(text, edits);
  let output = applied.text;
  let failed = false;
  if (edits.length) {
    const check = parseJs(output, { filename: ctx.path, sourceType: ctx.sourceType, jsx: ctx.jsx });
    if (!check.ok) {
      failed = true;
      notes.push(`Safety check failed (${check.error.message}); this file was left unchanged.`);
      applied = { text, removed: [], changed: [] };
      output = text;
    }
  }

  const lineStarts = ctx.lineStarts;
  const outLineStarts = buildLineIndex(output);

  // findings
  const findings = [];
  for (const c of cands) {
    const removed = !failed && removedSet.has(c);
    if (c.status === STATUS.USED && !removed) continue;
    const status = c.status === STATUS.USED ? (c.safeAble ? STATUS.SAFE_TO_REMOVE : STATUS.POTENTIALLY_UNUSED) : c.status;
    const confidence = c.status === STATUS.USED ? (c.safeAble ? CONFIDENCE.SAFE : CONFIDENCE.POTENTIAL) : c.confidence;
    const reasons = c.status === STATUS.USED ? ['Only referenced by code that was removed'] : c.reasons;
    findings.push({
      id: c.id,
      file: ctx.displayPath,
      lang: 'js',
      kind: c.kind,
      name: c.name,
      status,
      confidence,
      reasons,
      exported: !!(c.binding && c.binding.exportedAs.length),
      removable: c.removable,
      start: c.start,
      end: c.end,
      startLine: offsetToLine(lineStarts, c.start),
      endLine: offsetToLine(lineStarts, Math.max(c.start, c.end - 1)),
      bytes: byteLength(text.slice(c.start, c.end)),
      removed,
    });
  }

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

  let final = output;
  let minified = false;
  if (options.minifyJs) {
    if (ctx.hasJsx) notes.push('Minification skipped: this file contains JSX, which needs a build step first.');
    else {
      const m = await minifyJs(output, ctx.isModule);
      if (m.ok) {
        final = m.text;
        minified = true;
      } else notes.push(`Minification skipped: ${m.error}`);
    }
  }

  // Potential reduction: everything that is SAFE or POTENTIAL (UNKNOWN is excluded: too uncertain to promise).
  const potentialRanges = findings
    .filter((f) => f.confidence !== CONFIDENCE.UNKNOWN && f.removable !== false)
    .map((f) => ({ start: f.start, end: f.end }));
  const potentialBytes = disjointBytes(text, potentialRanges);

  return {
    path: ctx.path,
    displayPath: ctx.displayPath,
    lang: 'js',
    output,
    final,
    minified,
    notes,
    findings,
    removedRanges,
    changedRanges,
    bytes: { original: byteLength(text), purified: byteLength(output), final: byteLength(final) },
    potentialBytes,
  };
}

function disjointBytes(text, ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  let total = 0;
  let cursor = -1;
  for (const r of sorted) {
    if (r.end <= cursor) continue;
    const s = Math.max(r.start, cursor);
    total += byteLength(text.slice(s, r.end));
    cursor = r.end;
  }
  return total;
}

function deadEdit(ctx, c) {
  const meta = { id: c.id, confidence: CONFIDENCE.SAFE };
  if (c.replacement) return { start: c.start, end: c.end, replacement: c.replacement, meta };
  return statementEdit(ctx, c.start, c.end, meta, false);
}

function statementEdit(ctx, start, end, meta, attachComments = true) {
  const { text } = ctx;
  const s0 = attachComments ? leadingCommentStart(ctx, start) : start;
  const r = expandRemovalRange(text, s0, end);
  // ASI guard: removing a statement may glue `a = b` and `(c)()` together.
  const { next, prev } = neighbours(ctx, r.start, r.end);
  let replacement = '';
  if (next && '([`+-/'.includes(next) && prev !== null && prev !== ';' && prev !== '{') replacement = ';\n';
  return { ...r, replacement, meta };
}

/** First/last significant characters around a removed range, looking through whitespace and comments. */
function neighbours(ctx, start, end) {
  const { text, comments } = ctx;
  const byStart = new Map(comments.map((c) => [c.start, c.end]));
  const byEnd = new Map(comments.map((c) => [c.end - 1, c.start]));
  let i = end;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (byStart.has(i)) i = byStart.get(i);
    else break;
  }
  let j = start - 1;
  for (;;) {
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j >= 0 && byEnd.has(j)) j = byEnd.get(j) - 1;
    else break;
  }
  return { next: text[i], prev: j >= 0 ? text[j] : null };
}

function leadingCommentStart(ctx, start) {
  const { text, comments } = ctx;
  let s = start;
  // binary search: last comment ending at or before s
  const find = (pos) => {
    let lo = 0;
    let hi = comments.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (comments[mid].end <= pos) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };
  for (;;) {
    const idx = find(s);
    if (idx < 0) break;
    const c = comments[idx];
    if (LICENSE_COMMENT.test(c.value)) break;
    if (!/^[ \t]*(\r?\n)?[ \t]*$/.test(text.slice(c.end, s))) break;
    // the comment must start its own line (not trail some other statement)
    let ls = c.start;
    while (ls > 0 && text[ls - 1] !== '\n') ls--;
    if (!/^[ \t]*$/.test(text.slice(ls, c.start))) break;
    s = c.start;
  }
  return s;
}

let terserPromise = null;

/** Safe minification: no top-level mangling, no unsafe transforms, license comments kept. */
export async function minifyJs(code, isModule) {
  try {
    terserPromise ||= import('terser');
    const { minify } = await terserPromise;
    const result = await minify(code, {
      module: !!isModule,
      compress: { passes: 1, unused: false, toplevel: false, keep_fargs: true, drop_console: false },
      mangle: { toplevel: false },
      format: { comments: /^!|@license|@preserve|@cc_on/i },
      sourceMap: false,
    });
    if (typeof result.code !== 'string') return { ok: false, error: 'minifier returned no output' };
    return { ok: true, text: result.code };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
