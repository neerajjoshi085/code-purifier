/**
 * JavaScript project linker.
 *
 * Connects the per-file analyses into one picture:
 *   - resolves import/export edges across modules (incl. re-exports and `import * as ns`)
 *   - links classic-script globals to the HTML/JS that references them
 *   - classifies every removable declaration as USED / POTENTIALLY_UNUSED / SAFE_TO_REMOVE
 *     with a SAFE / POTENTIAL / UNKNOWN confidence
 *   - exposes a liveness solver the purifier re-runs for the user's chosen options
 *
 * Liveness (tree-shaking style): a declaration is alive when reachable from a root.
 * Roots are code that is not itself a removable declaration, plus anything referenced
 * from HTML, `window.x`, strings, dynamic imports or re-exports. Because references
 * are attributed to the removable declaration that contains them, chains of dead code
 * collapse together instead of keeping each other alive.
 */
import { CONFIDENCE, STATUS } from '../utils/constants.js';
import { resolveInProject, resolveRelative, normalizePath } from '../utils/path.js';

const GLOBAL_KINDS = new Set(['var', 'let', 'const', 'function', 'class']);

/**
 * Minimal view of the analysed files that the constant resolver needs. Created before
 * evidence is collected (the full project needs that evidence to classify code).
 */
export function makeResolverFacade(ctxs) {
  const ok = ctxs.filter((c) => c.ok);
  const ctxByPath = new Map(ok.map((c) => [c.path, c]));
  return {
    ctxByPath,
    ctxOfBinding: (b) => ctxByPath.get(b.ctxPath),
    callRefsFor(binding) {
      const refs = [...binding.refs];
      if (binding.scope && binding.scope.kind === 'program') {
        const ctx = ctxByPath.get(binding.ctxPath);
        if (ctx && !ctx.isModule) for (const c of ok) for (const r of c.globalRefs) if (r.name === binding.name) refs.push(r);
      }
      return refs;
    },
  };
}

export function createJsProject({ ctxs, files, basenameIndex, rootDir = '', importMap, handlerNames = new Set(), universe }) {
  const ok = ctxs.filter((c) => c.ok);
  const facade = makeResolverFacade(ctxs);
  const ctxByPath = facade.ctxByPath;
  const allCands = [];
  for (const c of ok) allCands.push(...c.candidates);

  /* ------------------------------------------------------------ module resolution */

  function resolveSpecifier(ctx, source) {
    if (!source) return null;
    if (importMap && importMap[source]) {
      const mapped = importMap[source];
      if (/^(?:[a-z]+:)?\/\//i.test(mapped)) return null;
      const p = resolveRelative('', mapped.replace(/^\//, ''));
      if (p && files.has(p)) return p;
    }
    if (!/^(?:\.{0,2}\/|\/)/.test(source)) return null; // bare specifier → external package
    return resolveInProject(files, basenameIndex, ctx.unit.parentPath || ctx.path, source, rootDir);
  }

  /** Resolve every import/require/dynamic-import of a ctx to project paths (for the dependency graph). */
  function importEdges(ctx) {
    const out = [];
    for (const imp of ctx.imports) {
      const target = resolveSpecifier(ctx, imp.source);
      out.push({ source: imp.source, kind: imp.kind, target, external: !target, line: imp.node ? ctx.lineOf(imp.node.start) : 0 });
    }
    return out;
  }

  const exportCache = new Map();
  function exportInfo(ctx) {
    let info = exportCache.get(ctx.path);
    if (info) return info;
    info = { named: new Map(), specs: [], stars: [] };
    exportCache.set(ctx.path, info);
    for (const b of ctx.bindings) for (const e of b.exportedAs) info.named.set(e.name, b);
    for (const r of ctx.reexports) {
      const target = resolveSpecifier(ctx, r.source);
      const tctx = target ? ctxByPath.get(target) : null;
      if (r.star) info.stars.push({ tctx, as: r.as });
      else {
        for (const spec of r.node.specifiers) {
          const imported = spec.local.type === 'Identifier' ? spec.local.name : String(spec.local.value);
          const exported = spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value);
          info.specs.push({ tctx, imported, exported });
        }
      }
    }
    return info;
  }

  function resolveExport(ctx, name, seen = new Set()) {
    const key = ctx.path + '\0' + name;
    if (seen.has(key)) return null;
    seen.add(key);
    const info = exportInfo(ctx);
    if (info.named.has(name)) return info.named.get(name);
    for (const s of info.specs) {
      if (s.exported === name && s.tctx) {
        const r = resolveExport(s.tctx, s.imported, seen);
        if (r) return r;
      }
    }
    if (name !== 'default') {
      for (const s of info.stars) {
        if (!s.as && s.tctx) {
          const r = resolveExport(s.tctx, name, seen);
          if (r) return r;
        }
      }
    }
    return null;
  }

  function allExports(ctx, seen = new Set()) {
    if (seen.has(ctx.path)) return [];
    seen.add(ctx.path);
    const info = exportInfo(ctx);
    const out = new Set(info.named.values());
    for (const s of info.specs) if (s.tctx) {
      const r = resolveExport(s.tctx, s.imported);
      if (r) out.add(r);
    }
    for (const s of info.stars) if (s.tctx) for (const b of allExports(s.tctx, seen)) out.add(b);
    return [...out];
  }

  /* ------------------------------------------------------------ globals */

  /** name → bindings declared at the top level of classic scripts. */
  const globalBindings = new Map();
  for (const ctx of ok) {
    if (ctx.isModule) continue;
    for (const b of ctx.program.bindings.values()) {
      if (!GLOBAL_KINDS.has(b.kind)) continue;
      const arr = globalBindings.get(b.name);
      if (arr) arr.push(b);
      else globalBindings.set(b.name, [b]);
    }
  }


  /* ------------------------------------------------------------ roots & links */

  const rootBindings = new Set();
  const rootGlobalNames = new Set(handlerNames);
  const dynamicGlobal = ok.some((c) => c.flags.dynamicGlobalAccess || c.flags.hasEval || c.flags.hasNewFunction);
  const stringRefNames = new Map(); // global name -> why

  for (const ctx of ok) {
    for (const n of ctx.globalMemberRefs) rootGlobalNames.add(n);
    for (const code of ctx.stringHandlers) for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) rootGlobalNames.add(m[0]);

    for (const b of ctx.bindings) {
      for (const ref of b.refs) if (ref.from === null) rootBindings.add(b);
      if (!b.importInfo) continue;
      const target = resolveSpecifier(ctx, b.importInfo.source);
      const tctx = target ? ctxByPath.get(target) : null;
      if (!tctx) continue;
      if (b.importInfo.imported === '*') {
        for (const ref of b.refs) {
          if (ref.nsMember === undefined) continue;
          const targets = ref.nsMember ? [resolveExport(tctx, ref.nsMember)] : allExports(tctx);
          for (const t of targets) {
            if (!t) continue;
            if (ref.from) ref.from.outRefs.add(t);
            else rootBindings.add(t);
          }
        }
      } else {
        const t = resolveExport(tctx, b.importInfo.imported);
        if (t) {
          b.target = t;
          for (const cand of b.candidates) cand.outRefs.add(t);
        }
      }
    }
    for (const ref of ctx.globalRefs) if (ref.from === null) rootGlobalNames.add(ref.name);

    for (const imp of ctx.imports) {
      if (imp.kind === 'dynamic' || imp.kind === 'require') {
        const t = resolveSpecifier(ctx, imp.source);
        const tctx = t ? ctxByPath.get(t) : null;
        if (tctx) for (const b of allExports(tctx)) rootBindings.add(b);
      }
    }
    for (const r of ctx.reexports) {
      const t = resolveSpecifier(ctx, r.source);
      const tctx = t ? ctxByPath.get(t) : null;
      if (!tctx) continue;
      if (r.star) for (const b of allExports(tctx)) rootBindings.add(b);
      else
        for (const spec of r.node.specifiers) {
          const imported = spec.local.type === 'Identifier' ? spec.local.name : String(spec.local.value);
          const tb = resolveExport(tctx, imported);
          if (tb) rootBindings.add(tb);
        }
    }
  }
  // Names mentioned as strings anywhere (HTML attributes, JS strings) may be looked up dynamically.
  for (const name of globalBindings.keys()) {
    if (universe.htmlWords.has(name)) {
      rootGlobalNames.add(name);
      stringRefNames.set(name, 'referenced in an HTML attribute');
    } else if (universe.js.words.has(name)) {
      rootGlobalNames.add(name);
      stringRefNames.set(name, `referenced as a string (${universe.js.words.get(name)})`);
    }
  }
  for (const name of handlerNames) if (globalBindings.has(name)) stringRefNames.set(name, 'called from an inline HTML event handler');

  /* ------------------------------------------------------------ classification flags */

  for (const c of allCands) {
    c.reasons = [];
    if (c.kind === 'dead-code') {
      c.safeAble = true;
      continue;
    }
    const b = c.binding;
    const ctx = c.ctx;
    const scope = b ? b.scope : null;
    const isGlobalScript = !!scope && scope.kind === 'program' && !ctx.isModule;
    const exported = !!b && b.exportedAs.length > 0;
    const dynamic = !!scope && scope.dynamic;
    const why = [];
    if (exported) {
      const names = [...new Set(b.exportedAs.map((e) => e.name))].join(', ');
      why.push(`exported as "${names}" — may be imported by code outside this project`);
      if (b.exportedAs.some((e) => e.via !== 'inline')) c.removable = false;
    }
    if (isGlobalScript) why.push('declared in the global scope of a classic script — may be used by HTML, other pages, or the console');
    if (!c.pure) why.push(c.impureReason || 'initialiser may have side effects');
    if (dynamic) why.push('eval() or with() in scope — references cannot be tracked');
    if (b && b.annexB) why.push('function declared inside a block in sloppy mode (hoisting semantics)');
    if (c.kind === 'import' && dynamic) why.push('eval() in scope');
    c.safeAble = why.length === 0;
    c.unknown = dynamic || (isGlobalScript && dynamicGlobal);
    c.whyNotSafe = why;
    if (isGlobalScript && stringRefNames.has(b.name)) c.stringRef = stringRefNames.get(b.name);
  }

  /* ------------------------------------------------------------ liveness solver */

  /**
   * @param {(c:any)=>boolean} isEligible whether a candidate may be removed under the policy
   * @returns {Set<any>} live candidates
   */
  function solve(isEligible) {
    const live = new Set();
    const queue = [];
    const mark = (c) => {
      if (!live.has(c)) {
        live.add(c);
        queue.push(c);
      }
    };
    const markBinding = (b) => {
      for (const c of b.candidates) mark(c);
    };
    for (const c of allCands) if (!isEligible(c)) mark(c);
    for (const b of rootBindings) markBinding(b);
    for (const n of rootGlobalNames) {
      const arr = globalBindings.get(n);
      if (arr) arr.forEach(markBinding);
    }
    while (queue.length) {
      const c = queue.pop();
      for (const b of c.outRefs) markBinding(b);
      for (const n of c.outGlobals) {
        const arr = globalBindings.get(n);
        if (arr) arr.forEach(markBinding);
      }
    }
    return live;
  }

  const liveSafe = solve((c) => c.safeAble);
  const liveAll = solve(() => true);

  for (const c of allCands) {
    if (c.kind === 'dead-code') {
      c.status = STATUS.SAFE_TO_REMOVE;
      c.confidence = CONFIDENCE.SAFE;
      c.reasons = [c.label === 'unreachable' ? 'Statement after return/throw/break/continue can never run' : `Branch can never run (${c.label})`];
    } else if (liveAll.has(c)) {
      c.status = STATUS.USED;
      c.confidence = null;
      c.reasons = [c.stringRef ? `Referenced: ${c.stringRef}` : 'Referenced by live code'];
    } else if (c.safeAble && !liveSafe.has(c)) {
      c.status = STATUS.SAFE_TO_REMOVE;
      c.confidence = CONFIDENCE.SAFE;
      c.reasons = [c.kind === 'import' ? 'Imported binding is never used in this file' : 'Never referenced — not exported, not global, no side effects'];
    } else {
      c.status = STATUS.POTENTIALLY_UNUSED;
      c.confidence = c.unknown ? CONFIDENCE.UNKNOWN : CONFIDENCE.POTENTIAL;
      c.reasons = c.whyNotSafe && c.whyNotSafe.length ? [...c.whyNotSafe] : [];
      // Referenced, but only from declarations that are themselves potentially unused: say who uses
      // it, so nobody removes e.g. a class whose instance is created by `const app = new App()`.
      const users = [];
      for (const ref of (c.binding && c.binding.refs) || []) {
        if (ref.mode === 'write' || !ref.from || ref.from === c) continue;
        const name = ref.from.name || ref.from.kind;
        if (name && !users.includes(name)) users.push(name);
      }
      if (users.length) {
        const list = users.slice(0, 3).map((u) => `"${u}"`).join(', ') + (users.length > 3 ? '…' : '');
        c.reasons.unshift(`Only used by ${list}, which ${users.length === 1 ? 'is' : 'are'} potentially unused — removing ${users.length === 1 ? 'it' : 'them'} would remove this too`);
      } else {
        c.reasons.unshift('No references found');
      }
    }
  }

  /* ------------------------------------------------------------ insights */

  return {
    ok,
    ctxByPath,
    candidates: allCands,
    solve,
    liveAll,
    liveSafe,
    callRefsFor: facade.callRefsFor,
    ctxOfBinding: facade.ctxOfBinding,
    importEdges,
    resolveSpecifier,
    exportInfo,
    globalBindings,
    dynamicGlobal,
    rootGlobalNames,
    stringRefNames,
  };
}

export { normalizePath };
