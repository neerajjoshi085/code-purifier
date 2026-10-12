/**
 * Static string resolver.
 *
 * Given an expression node it computes the set of strings the expression may
 * evaluate to, using literals, template literals, concatenation, conditionals,
 * `const` bindings, small object/array lookups, `[...].join(' ')`, class-name
 * helper calls (clsx/classnames) and — one level deep — the arguments of every
 * call site of the enclosing function.
 *
 * Unknown parts are represented by the WILD marker, so `'btn-' + type`
 * resolves to `["btn-"]` — a fragment pattern rather than "unknown".
 */

export const WILD = '';

const MAX_ALTS = 24;
const MAX_DEPTH = 7;
const CLASS_HELPERS = new Set(['classnames', 'classNames', 'clsx', 'cx', 'cn']);
const PASS_THROUGH = new Set(['trim', 'toString', 'valueOf', 'toLowerCase', 'toUpperCase', 'filter', 'flat', 'slice', 'reverse', 'sort']);
const ARRAY_ITER = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'flatMap', 'reduce']);

function cross(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      out.push(x + y);
      if (out.length > MAX_ALTS) return [WILD];
    }
  }
  return out;
}

function union(a, b) {
  const set = new Set(a);
  for (const x of b) set.add(x);
  return set.size > MAX_ALTS ? [WILD] : [...set];
}

const UNKNOWN = () => [WILD];

/**
 * @param {any} node
 * @param {import('./jsScope.js').Scope} scope
 * @param {{ project: any, seen: Set<string> }} rc
 */
export function resolveAlts(node, scope, rc, depth = 0) {
  if (!node || depth > MAX_DEPTH) return UNKNOWN();
  const r = (n, s = scope) => resolveAlts(n, s, rc, depth + 1);
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') return [node.value];
      if (node.regex) return UNKNOWN();
      return [node.value === null ? '' : String(node.value)];
    case 'TemplateLiteral': {
      let acc = [''];
      for (let i = 0; i < node.quasis.length; i++) {
        acc = cross(acc, [node.quasis[i].value.cooked ?? '']);
        if (i < node.expressions.length) acc = cross(acc, r(node.expressions[i]));
      }
      return acc;
    }
    case 'BinaryExpression':
      if (node.operator === '+') return cross(r(node.left), r(node.right));
      return UNKNOWN();
    case 'ConditionalExpression':
      return union(r(node.consequent), r(node.alternate));
    case 'LogicalExpression':
      return union(r(node.left), r(node.right));
    case 'AssignmentExpression':
      return r(node.right);
    case 'SequenceExpression':
      return r(node.expressions[node.expressions.length - 1]);
    case 'ChainExpression':
      return r(node.expression);
    case 'ArrayExpression': {
      let out = [];
      for (const el of node.elements) {
        if (!el) continue;
        out = union(out, el.type === 'SpreadElement' ? r(el.argument) : r(el));
      }
      return out.length ? out : [''];
    }
    case '__IterElement':
      return r(node.source);
    case 'Identifier':
      return resolveIdentifier(node, scope, rc, depth);
    case 'MemberExpression':
      return resolveMember(node, scope, rc, depth);
    case 'CallExpression':
      return resolveCall(node, scope, rc, depth);
    default:
      return UNKNOWN();
  }
}

function resolveIdentifier(node, scope, rc, depth) {
  if (node.name === 'undefined') return [''];
  const b = scope.lookup(node.name);
  if (!b) return UNKNOWN();
  if (rc.seen.has(b.id)) return UNKNOWN();
  rc.seen.add(b.id);
  try {
    if (b.kind === 'var' || b.kind === 'let' || b.kind === 'const') {
      if (!b.assigned.length) return UNKNOWN();
      let out = [];
      for (const a of b.assigned) out = union(out, resolveAlts(a.expr, a.scope, rc, depth + 1));
      // `x += piece`: whatever x held before (unknown here), followed by the piece.
      const appended = b.appended || [];
      for (const a of appended) out = union(out, cross([WILD], resolveAlts(a.expr, a.scope, rc, depth + 1)));
      // Any other compound update (x++, x -= …) makes the value unknown.
      const readwrites = b.refs.filter((ref) => ref.mode === 'readwrite').length;
      if (readwrites > appended.length) out = union(out, UNKNOWN());
      return out;
    }
    if (b.kind === 'param') return resolveParam(b, rc, depth);
    return UNKNOWN();
  } finally {
    rc.seen.delete(b.id);
  }
}

function resolveParam(binding, rc, depth) {
  const info = binding.paramInfo;
  if (!info || !info.simple || info.rest) return UNKNOWN();
  const fn = info.fn;
  const ctx = rc.project.ctxOfBinding(binding);
  const parent = ctx ? ctx.fnParent.get(fn) : null;
  const outer = ctx && ctx.scopeOf.get(fn) ? ctx.scopeOf.get(fn).parent : null;

  // IIFE: (function (cls) { ... })('open')
  if (outer && parent && parent.type === 'CallExpression' && parent.callee === fn) {
    const arg = parent.arguments[info.index];
    if (!arg || arg.type === 'SpreadElement') return UNKNOWN();
    return resolveAlts(arg, outer, rc, depth + 1);
  }
  // callback: ['a', 'b'].forEach(function (cls) { ... })
  if (outer && parent && parent.type === 'CallExpression' && parent.arguments.includes(fn) && parent.callee.type === 'MemberExpression' && info.index === 0) {
    const m = parent.callee.computed ? null : parent.callee.property.name;
    if (m && ARRAY_ITER.has(m)) return resolveAlts(parent.callee.object, outer, rc, depth + 1);
  }

  const fnBinding = ctx ? ctx.fnBinding.get(fn) : null;
  if (!fnBinding) return UNKNOWN();
  const refs = rc.project.callRefsFor(fnBinding);
  if (!refs.length) return UNKNOWN();
  let out = [];
  for (const ref of refs) {
    if (!ref.callNode) return UNKNOWN(); // passed around as a value
    if (ref.callNode.arguments.some((a) => a.type === 'SpreadElement')) return UNKNOWN();
    const arg = ref.callNode.arguments[info.index];
    out = union(out, arg ? resolveAlts(arg, ref.scope, rc, depth + 1) : ['']);
    if (out.length === 1 && out[0] === WILD) return out;
  }
  return out;
}

function literalContainer(node, scope, rc) {
  if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression') return { node, scope };
  if (node.type === 'Identifier') {
    const b = scope.lookup(node.name);
    if (b && (b.kind === 'const' || b.kind === 'let' || b.kind === 'var') && b.assigned.length === 1) {
      const a = b.assigned[0];
      if (a.expr.type === 'ObjectExpression' || a.expr.type === 'ArrayExpression') return { node: a.expr, scope: a.scope };
    }
  }
  return null;
}

function resolveMember(node, scope, rc, depth) {
  const c = literalContainer(node.object, scope, rc);
  if (!c) return UNKNOWN();
  const prop = node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : null) : node.property.name;
  if (c.node.type === 'ArrayExpression') {
    if (prop === 'length') return UNKNOWN();
    return resolveAlts(c.node, c.scope, rc, depth + 1);
  }
  let out = [];
  for (const p of c.node.properties) {
    if (p.type !== 'Property') return UNKNOWN();
    const key = p.computed ? null : (p.key.name ?? String(p.key.value));
    if (prop !== null && key !== null && key !== prop) continue;
    out = union(out, resolveAlts(p.value, c.scope, rc, depth + 1));
  }
  return out.length ? out : UNKNOWN();
}

function resolveClassHelperArg(arg, scope, rc, depth) {
  if (!arg) return [''];
  if (arg.type === 'ObjectExpression') {
    let out = [''];
    for (const p of arg.properties) {
      if (p.type !== 'Property') return UNKNOWN();
      const key = p.computed ? resolveAlts(p.key, scope, rc, depth + 1) : [p.key.name ?? String(p.key.value)];
      out = cross(out, cross([' '], key));
    }
    return out;
  }
  if (arg.type === 'ArrayExpression') {
    let out = [''];
    for (const el of arg.elements) if (el) out = cross(out, cross([' '], resolveClassHelperArg(el.type === 'SpreadElement' ? el.argument : el, scope, rc, depth + 1)));
    return out;
  }
  if (arg.type === 'ConditionalExpression') return union(resolveClassHelperArg(arg.consequent, scope, rc, depth + 1), resolveClassHelperArg(arg.alternate, scope, rc, depth + 1));
  if (arg.type === 'LogicalExpression') return union(resolveClassHelperArg(arg.left, scope, rc, depth + 1), resolveClassHelperArg(arg.right, scope, rc, depth + 1));
  return resolveAlts(arg, scope, rc, depth + 1);
}

function resolveCall(node, scope, rc, depth) {
  const c = node.callee;
  if (c.type === 'Identifier') {
    if (CLASS_HELPERS.has(c.name)) {
      let out = [''];
      for (const a of node.arguments) out = cross(out, cross([' '], resolveClassHelperArg(a.type === 'SpreadElement' ? a.argument : a, scope, rc, depth + 1)));
      return out;
    }
    if (c.name === 'String' && node.arguments[0]) return resolveAlts(node.arguments[0], scope, rc, depth + 1);
    return UNKNOWN();
  }
  if (c.type === 'MemberExpression' && !c.computed) {
    const m = c.property.name;
    if (m === 'join') {
      const sepArg = node.arguments[0];
      const sep = !sepArg ? [','] : sepArg.type === 'Literal' && typeof sepArg.value === 'string' ? [sepArg.value] : [' '];
      const items = resolveElements(c.object, scope, rc, depth);
      if (!items) return UNKNOWN();
      let out = null;
      for (const alts of items) {
        out = out === null ? alts : cross(cross(out, sep), alts);
      }
      return out || [''];
    }
    if (m === 'concat') {
      let out = resolveAlts(c.object, scope, rc, depth + 1);
      for (const a of node.arguments) out = cross(cross(out, [' ']), resolveAlts(a, scope, rc, depth + 1));
      return out;
    }
    if (PASS_THROUGH.has(m)) return resolveAlts(c.object, scope, rc, depth + 1);
  }
  return UNKNOWN();
}

/** Alternatives for each element of an array expression/binding (null if not a known array). */
function resolveElements(node, scope, rc, depth) {
  let arr = node;
  let s = scope;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && PASS_THROUGH.has(node.callee.property.name)) {
    return resolveElements(node.callee.object, scope, rc, depth + 1);
  }
  if (arr.type === 'Identifier') {
    const c = literalContainer(arr, scope, rc);
    if (!c || c.node.type !== 'ArrayExpression') return null;
    arr = c.node;
    s = c.scope;
  }
  if (arr.type !== 'ArrayExpression') return null;
  return arr.elements.filter(Boolean).map((el) => (el.type === 'SpreadElement' ? resolveAlts(el.argument, s, rc, depth + 1) : resolveAlts(el, s, rc, depth + 1)));
}

/** True when the string carries no usable literal information at all. */
export function isFullyUnknown(alt) {
  return alt.replace(new RegExp(WILD, 'g'), '').trim().length === 0;
}
