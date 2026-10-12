/**
 * Engine pipeline — the single entry point used by the Web Worker, the CLI and the tests.
 * It has no DOM / React dependencies.
 *
 *   analyzeProject(entries)  → Analysis   (heavy; parse everything, build evidence, classify)
 *   purifyProject(analysis, options) → PurifyResult   (cheap; re-run when options change)
 *   buildReport(analysis)    → plain JSON for the UI
 */
import { CONFIDENCE, DEFAULT_OPTIONS, FILE_KIND, LIMITS, STATUS } from '../utils/constants.js';
import { byteLength, offsetToLine, buildLineIndex } from '../utils/text.js';
import { basename, isExternalUrl, resolveInProject } from '../utils/path.js';
import { createProject } from '../project/fileManager.js';
import { analyzeHtml } from '../analyzers/htmlAnalyzer.js';
import { analyzeCss } from '../analyzers/cssAnalyzer.js';
import { analyzeJsUnit, releaseJsCtx } from '../analyzers/jsAnalyzer.js';
import { applyJsEvidence } from '../analyzers/jsEvidence.js';
import { createJsProject, makeResolverFacade } from '../analyzers/jsProject.js';
import { Universe } from '../analyzers/universe.js';
import { purifyCssFiles } from '../purifiers/cssPurifier.js';
import { purifyJsFiles } from '../purifiers/jsPurifier.js';
import { applyEdits } from '../utils/edits.js';

export function normalizeOptions(options = {}) {
  return { ...DEFAULT_OPTIONS, ...options, overrides: { ...(options.overrides || {}) }, safelist: [...(options.safelist || [])] };
}

const noop = () => {};

/**
 * @param {import('../project/fileManager.js').FileEntry[]} entries
 * @param {{ onProgress?: (p:{stage:string, message:string, percent:number})=>void }} [opts]
 */
export async function analyzeProject(entries, opts = {}) {
  const progress = opts.onProgress || noop;
  const errors = [];
  const warnings = [];

  progress({ stage: 'read', message: 'Reading project…', percent: 2 });
  const project = createProject(entries);
  warnings.push(...project.warnings);
  const files = [...project.files.values()];
  const htmlFiles = files.filter((f) => f.kind === FILE_KIND.HTML);
  const cssFiles = files.filter((f) => f.kind === FILE_KIND.CSS);
  const jsFiles = files.filter((f) => f.kind === FILE_KIND.JS);

  if (!htmlFiles.length) {
    errors.push({
      kind: 'missing-html',
      severity: 'error',
      file: null,
      message: 'No HTML file was provided. CSS usage cannot be verified without markup, so nothing in your CSS will be removed automatically. Add an HTML file (or paste HTML) to enable CSS purification.',
    });
  }
  if (!cssFiles.length && !jsFiles.length && !htmlFiles.some((h) => /<style|<script/i.test(h.text))) {
    errors.push({ kind: 'nothing-to-purify', severity: 'warning', file: null, message: 'No CSS or JavaScript files were found to purify.' });
  }

  /* ---------------------------------------------------------- HTML */
  const universe = new Universe();
  const htmlAnalyses = [];
  const cssUnits = []; // { path, displayPath, text, inline, parentPath, range }
  const jsUnits = [];
  const scriptHints = new Map();

  let step = 0;
  const total = files.length || 1;
  for (const f of htmlFiles) {
    progress({ stage: 'html', message: `Parsing ${f.path}`, percent: 5 + Math.round((step++ / total) * 10) });
    const a = analyzeHtml(f.path, f.text);
    htmlAnalyses.push(a);
    if (!a.ok) {
      errors.push({ kind: 'html-parse', severity: 'error', file: f.path, message: `Could not parse HTML: ${a.error}` });
      universe.incomplete.push(`${f.path} could not be parsed`);
      continue;
    }
    universe.addHtml(a);
    for (const s of a.styleRefs) void s;
    for (const ref of a.scriptRefs) {
      const target = resolveInProject(project.files, project.basenameIndex, f.path, ref.src, project.rootDir);
      if (target && !scriptHints.has(target)) scriptHints.set(target, ref.module);
    }
    for (const s of a.inlineStyles) {
      cssUnits.push({ path: `${f.path}#style-${s.index}`, displayPath: `${f.path} <style> #${s.index}`, text: s.text, inline: true, parentPath: f.path, range: { start: s.start, end: s.end }, line: s.line });
    }
    for (const s of a.inlineScripts) {
      jsUnits.push({ path: `${f.path}#script-${s.index}`, displayPath: `${f.path} <script> #${s.index}`, baseDir: f.path, text: s.text, inline: true, parentPath: f.path, range: { start: s.start, end: s.end }, moduleHint: s.isModule ? true : false, line: s.line });
    }
    if (a.eventHandlers.length) {
      const text = a.eventHandlers.map((h) => `(function (event) {\n${h.code}\n}).call(this);`).join('\n');
      jsUnits.push({ path: `${f.path}#handlers`, displayPath: `${f.path} (inline event handlers)`, baseDir: f.path, text, inline: true, parentPath: f.path, handlers: true, moduleHint: false });
    }
  }
  const importMap = htmlAnalyses.find((a) => a.importMap)?.importMap || null;

  for (const f of cssFiles) cssUnits.push({ path: f.path, displayPath: f.path, text: f.text, inline: false });
  for (const f of jsFiles) jsUnits.push({ path: f.path, displayPath: f.path, baseDir: f.path, text: f.text, inline: false, moduleHint: scriptHints.has(f.path) ? scriptHints.get(f.path) : null });

  if (!htmlFiles.length) universe.incomplete.push('no HTML files were provided');

  /* ---------------------------------------------------------- JavaScript */
  const jsCtxs = [];
  let jsStep = 0;
  for (const u of jsUnits) {
    progress({ stage: 'js', message: `Analysing ${u.displayPath}`, percent: 18 + Math.round((jsStep++ / Math.max(1, jsUnits.length)) * 30) });
    const ctx = safe(() => analyzeJsUnit(u), (err) => ({ ok: false, unit: u, path: u.path, displayPath: u.displayPath, size: u.text.length, error: { message: String(err?.message || err), line: 1, column: 1 } }));
    jsCtxs.push(ctx);
    if (!ctx.ok) {
      if (u.handlers) {
        warnings.push(`Some inline event handlers in ${u.parentPath} could not be parsed and were ignored.`);
      } else {
        errors.push({ kind: 'js-parse', severity: 'error', file: u.displayPath, line: ctx.error.line, column: ctx.error.column, message: `Invalid JavaScript: ${ctx.error.message}. This file was skipped and left unchanged.` });
        universe.incomplete.push(`${u.displayPath} could not be parsed`);
      }
    }
  }

  progress({ stage: 'evidence', message: 'Resolving dynamic references…', percent: 52 });
  const facade = makeResolverFacade(jsCtxs);
  applyJsEvidence(universe, jsCtxs.filter((c) => c.ok), facade);
  for (const c of jsCtxs) if (c.ok) c.strings = new Set();

  // Third-party scripts (e.g. a carousel loaded from a CDN): read only for the classes and markup
  // they add. They are never linked, purified, listed or downloaded.
  const externalScripts = [];
  const evidenceCtxs = [];
  for (const e of opts.evidence || []) {
    if (!e || typeof e.text !== 'string' || !e.path) continue;
    const u = { path: `external:${e.path}`, displayPath: e.path, baseDir: e.path, text: e.text, inline: false, external: true, moduleHint: null };
    const ctx = safe(() => analyzeJsUnit(u), () => null);
    if (ctx && ctx.ok) {
      evidenceCtxs.push(ctx);
      externalScripts.push(e.path);
    } else warnings.push(`${e.path} (loaded from a CDN) could not be parsed, so classes it adds were not detected.`);
  }
  if (evidenceCtxs.length) {
    applyJsEvidence(universe, evidenceCtxs, makeResolverFacade(evidenceCtxs), { external: true });
    for (const c of evidenceCtxs) releaseJsCtx(c);
  }

  /* ---------------------------------------------------------- CSS */
  const cssModels = [];
  let cssStep = 0;
  for (const u of cssUnits) {
    progress({ stage: 'css', message: `Parsing ${u.displayPath}`, percent: 56 + Math.round((cssStep++ / Math.max(1, cssUnits.length)) * 22) });
    const model = safe(() => analyzeCss(u.path, u.text), (err) => ({ path: u.path, size: u.text.length, parseErrors: [{ message: String(err?.message || err), line: 1, column: 1, offset: 0 }], banners: [], children: [], imports: [], urls: [], selectorCount: 0, ruleCount: 0, ok: false }));
    model.unit = u;
    cssModels.push(model);
    for (const e of model.parseErrors.slice(0, 20)) {
      errors.push({ kind: 'css-parse', severity: 'warning', file: u.displayPath, line: e.line + (u.line ? u.line - 1 : 0), column: e.column, message: `Invalid CSS: ${e.message}. The parser recovered and the rest of the file was still analysed.` });
    }
    if (model.parseErrors.length > 20) warnings.push(`${u.displayPath}: ${model.parseErrors.length - 20} more CSS syntax problems not shown.`);
  }

  /* ---------------------------------------------------------- Link + classify */
  progress({ stage: 'link', message: 'Linking modules and classifying code…', percent: 82 });
  const jsProject = createJsProject({
    ctxs: jsCtxs,
    files: project.files,
    basenameIndex: project.basenameIndex,
    rootDir: project.rootDir,
    importMap,
    handlerNames: new Set(),
    universe,
  });

  progress({ stage: 'graph', message: 'Building dependency graph…', percent: 90 });
  const graph = buildGraph({ project, htmlAnalyses, cssModels, jsProject, jsCtxs, importMap });
  const insights = buildInsights(jsProject, jsCtxs);

  for (const c of jsProject.ok) releaseJsCtx(c);
  progress({ stage: 'done', message: 'Analysis complete', percent: 100 });

  return { project, htmlAnalyses, cssModels, jsCtxs, jsProject, universe, graph, insights, errors, warnings, cssUnits, jsUnits, externalScripts };
}

function safe(fn, onError) {
  try {
    return fn();
  } catch (err) {
    return onError(err);
  }
}

/* ------------------------------------------------------------------ purify */

/**
 * @param {Awaited<ReturnType<typeof analyzeProject>>} analysis
 * @param {Partial<typeof DEFAULT_OPTIONS>} rawOptions
 */
export async function purifyProject(analysis, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const { universe, project } = analysis;

  const cssInputs = analysis.cssModels.map((m) => ({ model: m, text: m.unit.text }));
  const cssResults = purifyCssFiles({ files: cssInputs, universe, options });
  const jsResults = await purifyJsFiles({ project: analysis.jsProject, options });

  const fileResults = {};
  const unitMeta = new Map();
  for (const u of analysis.cssUnits) unitMeta.set(u.path, { ...u, kind: 'css' });
  for (const u of analysis.jsUnits) unitMeta.set(u.path, { ...u, kind: 'js' });

  const findings = [];
  for (const [path, r] of cssResults) {
    const u = unitMeta.get(path);
    fileResults[path] = toFileResult(r, u, 'css');
    findings.push(...r.findings.map((f) => ({ ...f, file: u.displayPath })));
  }
  for (const [path, r] of jsResults) {
    const u = unitMeta.get(path);
    if (u.handlers) continue;
    fileResults[path] = toFileResult(r, u, 'js');
    findings.push(...r.findings);
  }

  // Failed JS parses: still list them so the UI can show "unchanged".
  for (const c of analysis.jsCtxs) {
    if (!c.ok && !c.unit.handlers) {
      fileResults[c.path] = {
        path: c.path,
        displayPath: c.displayPath,
        kind: 'js',
        inline: !!c.unit.inline,
        parentPath: c.unit.parentPath || null,
        original: c.unit.inline ? c.unit.text : undefined,
        output: c.unit.text,
        final: c.unit.text,
        minified: false,
        notes: ['Could not be parsed — left unchanged.'],
        findings: [],
        removedRanges: [],
        changedRanges: [],
        bytes: { original: byteLength(c.unit.text), purified: byteLength(c.unit.text), final: byteLength(c.unit.text) },
        failed: true,
      };
    }
  }

  // HTML outputs: splice purified inline <style>/<script> back in.
  for (const a of analysis.htmlAnalyses) {
    const f = project.files.get(a.path);
    const edits = [];
    for (const s of a.inlineStyles) {
      const r = fileResults[`${a.path}#style-${s.index}`];
      if (r && r.final !== s.text) edits.push({ start: s.start, end: s.end, replacement: r.final });
    }
    for (const s of a.inlineScripts) {
      const r = fileResults[`${a.path}#script-${s.index}`];
      if (r && r.final !== s.text) edits.push({ start: s.start, end: s.end, replacement: r.final.replace(/<\/script/gi, '<\\/script') });
    }
    const out = edits.length ? applyEdits(f.text, edits).text : f.text;
    fileResults[a.path] = {
      path: a.path,
      displayPath: a.path,
      kind: 'html',
      inline: false,
      output: out,
      final: out,
      minified: false,
      notes: edits.length ? ['Inline <style>/<script> blocks were purified.'] : [],
      findings: [],
      removedRanges: [],
      changedRanges: [],
      bytes: { original: f.size, purified: byteLength(out), final: byteLength(out) },
      changed: edits.length > 0,
    };
  }
  // Non-analysed HTML (parse failure) — pass through.
  for (const f of project.files.values()) {
    if (f.kind === FILE_KIND.HTML && !fileResults[f.path]) {
      fileResults[f.path] = { path: f.path, displayPath: f.path, kind: 'html', output: f.text, final: f.text, minified: false, notes: [], findings: [], removedRanges: [], changedRanges: [], bytes: { original: f.size, purified: f.size, final: f.size }, changed: false };
    }
  }

  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start));
  const stats = computeStats({ cssResults, jsResults, analysis, unitMeta });

  return {
    options,
    files: fileResults,
    findings: findings.slice(0, LIMITS.maxFindingsInReport),
    findingsTruncated: findings.length > LIMITS.maxFindingsInReport,
    stats,
  };
}

function toFileResult(r, u, kind) {
  return {
    path: r.path,
    displayPath: u.displayPath,
    kind,
    inline: !!u.inline,
    parentPath: u.parentPath || null,
    original: u.inline ? u.text : undefined,
    output: r.output,
    final: r.final,
    minified: r.minified,
    notes: r.notes,
    removedRanges: r.removedRanges,
    changedRanges: r.changedRanges,
    bytes: r.bytes,
    findingCount: r.findings.length,
    potentialBytes: r.potentialBytes ?? r.flaggedBytes ?? 0,
  };
}

function computeStats({ cssResults, jsResults, analysis, unitMeta }) {
  const css = {
    files: cssResults.size,
    originalBytes: 0,
    purifiedBytes: 0,
    removedBytes: 0,
    reduction: 0,
    selectors: { total: 0, used: 0, unused: 0, safe: 0, potential: 0, unknown: 0 },
    keyframes: { total: 0, unused: 0 },
    fonts: { total: 0, unused: 0 },
    variables: { total: 0, unused: 0 },
    potentialBytes: 0,
    usedSelectors: [],
  };
  for (const [, r] of cssResults) {
    css.originalBytes += r.bytes.original;
    css.purifiedBytes += r.bytes.final;
    const c = r.counts;
    css.selectors.total += c.selectors;
    css.selectors.used += c.used;
    css.selectors.safe += c.unusedSafe;
    css.selectors.potential += c.unusedPotential;
    css.selectors.unknown += c.unusedUnknown;
    css.keyframes.total += c.keyframes;
    css.keyframes.unused += c.keyframesUnused;
    css.fonts.total += c.fonts;
    css.fonts.unused += c.fontsUnused;
    css.variables.total += c.vars;
    css.variables.unused += c.varsUnused;
    css.potentialBytes += r.potentialBytes;
    if (css.usedSelectors.length < 3000) css.usedSelectors.push(...r.usedSelectors.slice(0, 3000 - css.usedSelectors.length));
  }
  css.selectors.unused = css.selectors.safe + css.selectors.potential + css.selectors.unknown;
  css.removedBytes = Math.max(0, css.originalBytes - css.purifiedBytes);
  css.reduction = css.originalBytes ? Math.round((css.removedBytes / css.originalBytes) * 1000) / 10 : 0;

  const js = {
    files: 0,
    originalBytes: 0,
    optimizedBytes: 0,
    removedBytes: 0,
    reduction: 0,
    potentialBytes: 0,
    potentialReduction: 0,
    functionsAnalyzed: 0,
    unusedFunctions: 0,
    potentiallyUnusedFunctions: 0,
    safeFunctions: 0,
    unusedImports: 0,
    unusedExports: 0,
    unusedVariables: 0,
    deadCode: 0,
    removedItems: 0,
    eventListeners: 0,
    domSelectors: 0,
    failedFiles: 0,
  };
  for (const [path, r] of jsResults) {
    const u = unitMeta.get(path);
    if (u.handlers) continue;
    js.files++;
    js.originalBytes += r.bytes.original;
    js.optimizedBytes += r.bytes.final;
    js.potentialBytes += r.potentialBytes;
    for (const f of r.findings) {
      if (f.kind === 'function' && f.status !== STATUS.USED) {
        js.unusedFunctions++;
        if (f.status === STATUS.POTENTIALLY_UNUSED) js.potentiallyUnusedFunctions++;
        else js.safeFunctions++;
      }
      if (f.kind === 'import') js.unusedImports++;
      if (f.kind === 'variable' || f.kind === 'class') js.unusedVariables++;
      if (f.kind === 'dead-code') js.deadCode++;
      if (f.exported) js.unusedExports++;
      if (f.removed) js.removedItems++;
    }
  }
  for (const c of analysis.jsProject.ok) {
    if (c.unit.handlers) js.eventListeners += c.eventListeners.length;
    else {
      js.functionsAnalyzed += c.functions.length;
      js.eventListeners += c.eventListeners.length;
      js.domSelectors += c.domSelectors.length;
    }
  }
  js.failedFiles = analysis.jsCtxs.filter((c) => !c.ok && !c.unit.handlers).length;
  js.removedBytes = Math.max(0, js.originalBytes - js.optimizedBytes);
  js.reduction = js.originalBytes ? Math.round((js.removedBytes / js.originalBytes) * 1000) / 10 : 0;
  js.potentialReduction = js.originalBytes ? Math.round((js.potentialBytes / js.originalBytes) * 1000) / 10 : 0;
  return { css, js };
}

/* ------------------------------------------------------------------ report */

export function buildReport(analysis) {
  const { project, htmlAnalyses, cssModels, jsCtxs, universe } = analysis;
  const files = [...project.files.values()].map((f) => ({ path: f.path, kind: f.kind, size: f.size }));
  const units = [];
  for (const m of cssModels) units.push({ path: m.path, displayPath: m.unit.displayPath, kind: 'css', inline: !!m.unit.inline, parentPath: m.unit.parentPath || null, size: m.size, ok: m.ok, rules: m.ruleCount, selectors: m.selectorCount });
  for (const c of jsCtxs) {
    if (c.unit.handlers) continue;
    units.push({ path: c.path, displayPath: c.displayPath, kind: 'js', inline: !!c.unit.inline, parentPath: c.unit.parentPath || null, size: c.size, ok: c.ok, module: c.ok ? c.isModule : null, jsx: c.ok ? c.hasJsx : false });
  }
  for (const a of htmlAnalyses) units.push({ path: a.path, displayPath: a.path, kind: 'html', inline: false, size: a.size, ok: a.ok, elements: a.elements.length });

  const unresolved = {};
  for (const k of Object.keys(universe.unresolved)) unresolved[k] = universe.unresolved[k].slice(0, 10);
  return {
    files,
    units,
    errors: analysis.errors,
    warnings: analysis.warnings,
    externalScripts: analysis.externalScripts || [],
    graph: analysis.graph,
    insights: analysis.insights,
    universe: {
      elements: universe.elements.length,
      classes: universe.classIndex.size,
      ids: universe.idIndex.size,
      tags: universe.tagIndex.size,
      jsClasses: universe.js.classes.size,
      patterns: universe.js.patterns.length,
      unresolved,
      incomplete: universe.incomplete,
      hasHtml: universe.hasHtml,
    },
    rootDir: project.rootDir,
  };
}

/* ------------------------------------------------------------------ graph + insights */

function buildGraph({ project, htmlAnalyses, cssModels, jsProject, jsCtxs, importMap }) {
  const nodes = [...project.files.values()].map((f) => ({ id: f.path, kind: f.kind, size: f.size }));
  const edges = [];
  const missing = [];
  const external = new Set();
  const externalScope = new Map(); // url → 'css' | 'js' | null
  const incoming = new Set();
  const resolve = (from, ref) => resolveInProject(project.files, project.basenameIndex, from, ref, project.rootDir);

  // `scope` records which language a reference belongs to: the CSS and JS pages each show only their own.
  const addRef = (from, ref, type, line, scope = null) => {
    if (!ref) return;
    if (isExternalUrl(ref)) {
      if (/^(?:https?:)?\/\//i.test(ref)) {
        external.add(ref);
        if (!externalScope.has(ref)) externalScope.set(ref, scope);
      }
      return;
    }
    if (ref.startsWith('#') || ref.startsWith('javascript:')) return;
    const target = resolve(from, ref);
    if (target) {
      edges.push({ from, to: target, type, line, scope });
      incoming.add(target);
    } else missing.push({ from, ref, type, line, scope });
  };

  for (const a of htmlAnalyses) {
    if (!a.ok) continue;
    for (const s of a.styleRefs) addRef(a.path, s.href, 'stylesheet', s.line, 'css');
    for (const s of a.scriptRefs) addRef(a.path, s.src, s.module ? 'module' : 'script', s.line, 'js');
    for (const r of a.resourceRefs) addRef(a.path, r.url, r.kind, r.line);
  }
  for (const m of cssModels) {
    const from = m.unit.parentPath || m.path;
    for (const i of m.imports) addRef(from, i.url, 'import', i.line, 'css');
    for (const u of m.urls) addRef(from, u.url, 'asset', u.line, 'css');
  }
  for (const c of jsProject.ok) {
    if (c.unit.handlers) continue;
    const from = c.unit.parentPath || c.path;
    for (const e of jsProject.importEdges(c)) {
      if (e.target) {
        edges.push({ from: c.path.includes('#') ? from : c.path, to: e.target, type: e.kind === 'static' ? 'import' : e.kind, line: e.line, scope: 'js' });
        incoming.add(e.target);
      } else if (e.source && /^(?:\.{0,2}\/|\/)/.test(e.source)) missing.push({ from: c.displayPath, ref: e.source, type: 'import', line: e.line, scope: 'js' });
      else if (e.source) {
        external.add(e.source);
        if (!externalScope.has(e.source)) externalScope.set(e.source, 'js');
      }
    }
    for (const r of c.resourceRefs) addRef(from, r.url, r.kind, r.line, 'js');
  }
  void jsCtxs;
  void importMap;
  const orphans = [...project.files.values()].filter((f) => (f.kind === FILE_KIND.CSS || f.kind === FILE_KIND.JS) && !incoming.has(f.path)).map((f) => f.path);
  const externalList = [...external].slice(0, 100);
  return { nodes, edges, missing, external: externalList, externalRefs: externalList.map((url) => ({ url, scope: externalScope.get(url) ?? null })), orphans };
}

function buildInsights(jsProject, jsCtxs) {
  const functions = [];
  const imports = [];
  const exports = [];
  const listeners = [];
  const selectors = [];
  const calls = new Map();
  const statusByFn = new Map();
  for (const c of jsProject.candidates) if (c.fnStart !== undefined) statusByFn.set(`${c.ctx.path}:${c.fnStart}`, c);

  for (const ctx of jsProject.ok) {
    if (ctx.unit.handlers) {
      for (const l of ctx.eventListeners) listeners.push({ file: ctx.displayPath, ...l });
      continue;
    }
    for (const fn of ctx.functions) {
      const cand = statusByFn.get(`${ctx.path}:${fn.start}`);
      functions.push({ name: fn.name, kind: fn.kind, file: ctx.displayPath, line: fn.line, status: cand ? cand.status : null, confidence: cand ? cand.confidence : null });
    }
    for (const e of jsProject.importEdges(ctx)) imports.push({ file: ctx.displayPath, source: e.source, kind: e.kind, target: e.target, external: e.external, line: e.line });
    const info = jsProject.exportInfo(ctx);
    for (const [name, b] of info.named) exports.push({ file: ctx.displayPath, name, kind: b.kind });
    for (const s of info.specs) exports.push({ file: ctx.displayPath, name: s.exported, kind: 're-export' });
    for (const l of ctx.eventListeners) listeners.push({ file: ctx.displayPath, ...l });
    for (const s of ctx.domSelectors) selectors.push({ file: ctx.displayPath, ...s });
    for (const [name, n] of ctx.callCounts) calls.set(name, (calls.get(name) || 0) + n);
  }
  const topCalls = [...calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count }));
  return {
    functions: functions.slice(0, 5000),
    imports: imports.slice(0, 3000),
    exports: exports.slice(0, 3000),
    listeners: listeners.slice(0, 2000),
    selectors: selectors.slice(0, 2000),
    calls: topCalls,
    totals: { functions: functions.length, imports: imports.length, exports: exports.length, listeners: listeners.length, selectors: selectors.length },
  };
}

export { CONFIDENCE, STATUS, basename, buildLineIndex, offsetToLine };
