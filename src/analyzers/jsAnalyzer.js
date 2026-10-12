/**
 * JavaScript Analyzer (per file): parse → scopes → references → DOM evidence → candidates.
 * Cross-file linking and liveness live in jsProject.js.
 */
import { parseJs } from '../parsers/jsParser.js';
import { buildLineIndex, offsetToLine } from '../utils/text.js';
import { analyzeScopes } from './jsScope.js';
import * as hooks from './jsDomRefs.js';

/**
 * @typedef {Object} JsUnit
 * @property {string} path          unique id (file path, or `page.html#script-1` for inline blocks)
 * @property {string} displayPath
 * @property {string} baseDir       directory used to resolve relative imports
 * @property {string} text
 * @property {boolean|null} moduleHint  true: loaded as a module, false: classic script, null: unknown
 * @property {boolean} [inline]
 * @property {string} [parentPath]
 * @property {{start:number,end:number}} [range]  location of an inline block inside its parent HTML
 */

/**
 * @param {JsUnit} unit
 */
export function analyzeJsUnit(unit) {
  const { path, displayPath, text } = unit;
  const lineStarts = buildLineIndex(text);
  const lineOf = (o) => offsetToLine(lineStarts, o);
  let candSeq = 0; // per file, so ids are deterministic across runs
  const parsed = parseJs(text, {
    filename: path,
    sourceType: unit.moduleHint === true ? 'module' : unit.moduleHint === false ? 'script' : 'auto',
  });
  if (!parsed.ok) {
    return { ok: false, unit, path, displayPath, size: text.length, error: parsed.error };
  }
  const ast = parsed.ast;
  const hasModuleSyntax = ast.body.some((n) => n.type === 'ImportDeclaration' || n.type.startsWith('Export'));
  const isModule = hasModuleSyntax || unit.moduleHint === true || /\.mjs$/i.test(path);

  /** @type {any} */
  const ctx = {
    ok: true,
    unit,
    path,
    displayPath,
    baseDir: unit.baseDir,
    text,
    size: text.length,
    lineStarts,
    lineOf,
    comments: parsed.comments,
    ast,
    sourceType: parsed.sourceType,
    isModule,
    jsx: parsed.jsx,
    hasJsx: false,
    scopeOf: null,
    program: null,
    bindings: [],
    candidates: [],
    fnBinding: new Map(),
    fnParent: new Map(),
    globalRefs: [],
    imports: [],
    reexports: [],
    exportLists: [],
    functions: [],
    eventListeners: [],
    domSelectors: [],
    callCounts: new Map(),
    strings: new Set(),
    htmlStrings: [],
    sinks: [],
    attrNames: new Set(),
    attrValues: [],
    tagNames: new Set(),
    jsxTags: new Set(),
    globalMemberRefs: new Set(),
    dynamicGlobalLines: [],
    resourceRefs: [],
    stringHandlers: [],
    importGroups: new Map(),
    bindingSeq: 0,
    flags: { hasEval: false, hasWith: false, hasNewFunction: false, dynamicGlobalAccess: false, dynamicImportUnresolved: false },
    newCandidate(props) {
      const c = {
        id: `js:${path}@${props.start}:${props.kind}:${props.name}:${candSeq++}`,
        ctx,
        kind: props.kind,
        name: props.name,
        binding: props.binding || null,
        start: props.start,
        end: props.end,
        line: lineOf(props.start),
        node: props.node,
        fnStart: props.fnStart,
        exportNode: props.exportNode || null,
        pure: props.pure !== false,
        impureReason: props.impureReason || null,
        label: props.label || null,
        replacement: props.replacement,
        removal: props.removal || { type: 'statement' },
        outRefs: new Set(),
        outGlobals: new Set(),
        // filled during classification
        safeAble: false,
        unknown: false,
        status: null,
        confidence: null,
        reasons: [],
        removable: true,
      };
      if (props.binding) props.binding.candidates.push(c);
      if (c.removal.type === 'import-specifier') {
        const { decl, spec } = c.removal;
        let group = ctx.importGroups.get(decl);
        if (!group) {
          group = {
            start: decl.start,
            end: decl.end,
            sourceRaw: text.slice(decl.source.start, decl.source.end),
            tail: text.slice(decl.source.end, decl.end),
            specs: [],
          };
          ctx.importGroups.set(decl, group);
        }
        const entry = {
          kind: spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'named',
          text: text.slice(spec.start, spec.end),
          cand: c,
        };
        group.specs.push(entry);
        c.removal = { type: 'import-specifier', group, entry };
      }
      ctx.candidates.push(c);
      return c;
    },
  };

  analyzeScopes(ctx, hooks);
  return ctx;
}

/** Frees the heavy AST/scope structures once evidence and classification are done. */
export function releaseJsCtx(ctx) {
  if (!ctx.ok) return;
  ctx.ast = null;
  ctx.sinks = [];
  ctx.scopeOf = null;
  ctx.program = null;
  ctx.fnBinding = null;
  ctx.fnParent = null;
  for (const b of ctx.bindings) {
    b.assigned = [];
    b.scope = null;
  }
  for (const c of ctx.candidates) c.node = null;
}
