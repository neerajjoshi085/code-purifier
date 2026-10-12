/**
 * JavaScript scope analysis (ESTree). Two passes:
 *
 *   1. declare — build scopes, hoist declarations, flag eval/with.
 *   2. resolve — resolve every identifier reference, attribute each reference to
 *      the removable declaration ("candidate") that contains it, and feed DOM /
 *      string evidence to the collector hooks.
 *
 * Attributing references to their enclosing candidate is what lets the liveness
 * solver (jsLiveness.js) discover whole chains of dead code: a function that is
 * only called from another dead function is itself dead.
 */
import { FUNCTION_TYPES, walkAst } from '../parsers/jsParser.js';
import { constantTruthiness, isPureClass, isPureExpression } from './jsPurity.js';

export class Scope {
  constructor(kind, parent, node) {
    this.kind = kind; // program | function | block | catch | class
    this.parent = parent;
    this.node = node;
    this.bindings = new Map();
    this.hasEval = false;
    this.hasWith = false;
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      const b = s.bindings.get(name);
      if (b) return b;
    }
    return null;
  }
  /** True if eval()/with exist in this scope or any enclosing one. */
  get dynamic() {
    for (let s = this; s; s = s.parent) if (s.hasEval || s.hasWith) return true;
    return false;
  }
  get isVarScope() {
    return this.kind === 'program' || this.kind === 'function';
  }
}

export class Binding {
  constructor(name, kind, scope, ctxPath, seq) {
    this.id = `${ctxPath}::${name}#${seq}`;
    this.name = name;
    this.kind = kind; // var | let | const | function | class | import | param | catch | fnexpr
    this.scope = scope;
    this.refs = [];
    this.candidates = [];
    this.exportedAs = []; // { name, via: 'inline' | 'list' | 'default-expr' }
    this.importInfo = null; // { source, imported: 'default' | '*' | name, spec, decl }
    this.assigned = []; // { expr, scope } — init + every `x = expr`
    this.paramInfo = null; // { fn, index, simple }
    this.fn = null; // function node this binding names, if any
    this.annexB = false;
    this.ctxPath = ctxPath;
  }
}

function patternIdentifiers(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern);
      break;
    case 'ObjectPattern':
      for (const p of pattern.properties) {
        if (p.type === 'RestElement') patternIdentifiers(p.argument, out);
        else patternIdentifiers(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const e of pattern.elements) patternIdentifiers(e, out);
      break;
    case 'AssignmentPattern':
      patternIdentifiers(pattern.left, out);
      break;
    case 'RestElement':
      patternIdentifiers(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

export function hasHoistedDeclaration(stmt) {
  let found = false;
  walkAst(stmt, (n) => {
    if (found) return false;
    if (n.type === 'FunctionDeclaration') {
      found = true;
      return false;
    }
    if (FUNCTION_TYPES.has(n.type) || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return false;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') found = true;
    return undefined;
  });
  return found;
}

const DEAD_ELIGIBLE = new Set([
  'ExpressionStatement',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'TryStatement',
  'SwitchStatement',
  'BlockStatement',
  'ReturnStatement',
  'ThrowStatement',
  'BreakStatement',
  'ContinueStatement',
  'LabeledStatement',
]);

const TERMINATORS = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement']);

/**
 * Pass 1 + 2 driver.
 * @param {import('./jsAnalyzer.js').FileCtx} ctx
 * @param {{ onCall:Function, onAssign:Function, onMember:Function, onLiteral:Function, onTemplate:Function, onBinaryConcat:Function, onNew:Function, onJsxAttribute:Function, onJsxElement:Function, onImportExpression:Function }} hooks
 */
export function analyzeScopes(ctx, hooks) {
  const { ast, text } = ctx;
  const path = ctx.path;
  const scopeOf = new Map();
  ctx.scopeOf = scopeOf;

  const program = new Scope('program', null, ast);
  ctx.program = program;
  scopeOf.set(ast, program);

  const allBindings = [];
  ctx.bindings = allBindings;

  function declare(scope, name, kind, extra = {}) {
    let b = scope.bindings.get(name);
    if (!b) {
      b = new Binding(name, kind, scope, path, ++ctx.bindingSeq);
      scope.bindings.set(name, b);
      allBindings.push(b);
    } else if (kind === 'function' || kind === 'class' || kind === 'import') {
      b.kind = kind;
    }
    Object.assign(b, extra);
    return b;
  }

  function markEvalChain(scope, key) {
    for (let s = scope; s; s = s.parent) s[key] = true;
  }

  /* ------------------------------------------------------------ pass 1 */

  function bindPattern(pattern, scope, kind, declarator) {
    const ids = patternIdentifiers(pattern);
    for (const id of ids) {
      const b = declare(scope, id.name, kind);
      if (pattern.type === 'Identifier' && declarator && declarator.init) {
        b.assigned.push({ expr: declarator.init, scope });
      }
    }
  }

  function declareExported(node, names, via) {
    for (const name of names) {
      const b = program.bindings.get(name.local);
      if (b) b.exportedAs.push({ name: name.exported, via, node });
    }
  }

  function d(node, scope, fscope) {
    if (!node) return;
    switch (node.type) {
      case 'ImportDeclaration': {
        for (const spec of node.specifiers) {
          const imported =
            spec.type === 'ImportDefaultSpecifier'
              ? 'default'
              : spec.type === 'ImportNamespaceSpecifier'
                ? '*'
                : spec.imported.type === 'Identifier'
                  ? spec.imported.name
                  : String(spec.imported.value);
          const b = declare(program, spec.local.name, 'import');
          b.importInfo = { source: node.source.value, imported, spec, decl: node };
        }
        ctx.imports.push({ source: node.source.value, node, kind: 'static' });
        return;
      }
      case 'ExportNamedDeclaration': {
        if (node.declaration) {
          d(node.declaration, scope, fscope);
          const names = [];
          const decl = node.declaration;
          if (decl.type === 'VariableDeclaration') {
            for (const dd of decl.declarations) {
              for (const id of patternIdentifiers(dd.id)) names.push({ local: id.name, exported: id.name });
            }
          } else if (decl.id) names.push({ local: decl.id.name, exported: decl.id.name });
          declareExported(node, names, 'inline');
        } else if (node.source) {
          ctx.reexports.push({ source: node.source.value, node, star: false });
          ctx.imports.push({ source: node.source.value, node, kind: 'reexport' });
        } else {
          const names = [];
          for (const spec of node.specifiers) {
            const exported = spec.exported.type === 'Identifier' ? spec.exported.name : String(spec.exported.value);
            names.push({ local: spec.local.name, exported });
          }
          ctx.exportLists.push({ node, names });
        }
        return;
      }
      case 'ExportDefaultDeclaration': {
        const decl = node.declaration;
        if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
          d(decl, scope, fscope);
          declareExported(node, [{ local: decl.id.name, exported: 'default' }], 'inline');
        } else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
          d(decl, scope, fscope); // anonymous
        } else if (decl.type === 'Identifier') {
          ctx.exportLists.push({ node, names: [{ local: decl.name, exported: 'default' }], defaultExpr: true });
        } else {
          d(decl, scope, fscope);
        }
        return;
      }
      case 'ExportAllDeclaration': {
        ctx.reexports.push({ source: node.source.value, node, star: true, as: node.exported ? (node.exported.name ?? String(node.exported.value)) : null });
        ctx.imports.push({ source: node.source.value, node, kind: 'reexport' });
        return;
      }
      case 'VariableDeclaration': {
        const target = node.kind === 'var' ? fscope : scope;
        for (const dd of node.declarations) {
          bindPattern(dd.id, target, node.kind, dd);
          if (dd.id.type === 'Identifier' && dd.init && (dd.init.type === 'FunctionExpression' || dd.init.type === 'ArrowFunctionExpression' || dd.init.type === 'ClassExpression')) {
            const b = target.bindings.get(dd.id.name);
            if (b && dd.init.type !== 'ClassExpression') {
              b.fn = dd.init;
              ctx.fnBinding.set(dd.init, b);
            }
          }
          d(dd.init, scope, fscope);
          // destructuring patterns may contain default-value expressions
          if (dd.id.type !== 'Identifier') d(dd.id, scope, fscope);
        }
        return;
      }
      case 'FunctionDeclaration': {
        let b = null;
        if (node.id) {
          b = declare(scope, node.id.name, 'function');
          if (scope.kind === 'block' && !ctx.isModule) b.annexB = true;
          b.fn = node;
          ctx.fnBinding.set(node, b);
        }
        declareFunction(node, scope, null);
        return;
      }
      case 'FunctionExpression': {
        declareFunction(node, scope, node.id ? node.id.name : null);
        return;
      }
      case 'ArrowFunctionExpression': {
        declareFunction(node, scope, null);
        return;
      }
      case 'ClassDeclaration': {
        if (node.id) declare(scope, node.id.name, 'class');
        d(node.superClass, scope, fscope);
        d(node.body, scope, fscope);
        return;
      }
      case 'ClassExpression': {
        const cs = new Scope('class', scope, node);
        scopeOf.set(node, cs);
        if (node.id) declare(cs, node.id.name, 'fnexpr');
        d(node.superClass, cs, fscope);
        d(node.body, cs, fscope);
        return;
      }
      case 'StaticBlock': {
        const fs = new Scope('function', scope, node);
        scopeOf.set(node, fs);
        for (const s of node.body) d(s, fs, fs);
        return;
      }
      case 'BlockStatement': {
        const bs = new Scope('block', scope, node);
        scopeOf.set(node, bs);
        for (const s of node.body) d(s, bs, fscope);
        return;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const bs = new Scope('block', scope, node);
        scopeOf.set(node, bs);
        if (node.type === 'ForStatement') {
          d(node.init, bs, fscope);
          d(node.test, bs, fscope);
          d(node.update, bs, fscope);
        } else {
          d(node.left, bs, fscope);
          d(node.right, bs, fscope);
          if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration' && node.left.declarations.length === 1 && node.left.declarations[0].id.type === 'Identifier') {
            const target = node.left.kind === 'var' ? fscope : bs;
            const b = target.bindings.get(node.left.declarations[0].id.name);
            if (b) b.assigned.push({ expr: { type: '__IterElement', source: node.right }, scope: bs });
          }
        }
        d(node.body, bs, fscope);
        return;
      }
      case 'SwitchStatement': {
        d(node.discriminant, scope, fscope);
        const bs = new Scope('block', scope, node);
        scopeOf.set(node, bs);
        for (const c of node.cases) {
          d(c.test, bs, fscope);
          for (const s of c.consequent) d(s, bs, fscope);
        }
        return;
      }
      case 'CatchClause': {
        const cs = new Scope('catch', scope, node);
        scopeOf.set(node, cs);
        if (node.param) bindPattern(node.param, cs, 'catch', null);
        d(node.body, cs, fscope);
        return;
      }
      case 'WithStatement': {
        markEvalChain(scope, 'hasWith');
        ctx.flags.hasWith = true;
        d(node.object, scope, fscope);
        d(node.body, scope, fscope);
        return;
      }
      case 'CallExpression': {
        if (node.callee.type === 'Identifier' && node.callee.name === 'eval') {
          markEvalChain(scope, 'hasEval');
          ctx.flags.hasEval = true;
        }
        break;
      }
      case 'NewExpression': {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Function') ctx.flags.hasNewFunction = true;
        break;
      }
      case 'JSXElement':
      case 'JSXFragment':
        ctx.hasJsx = true;
        break;
      default:
        break;
    }
    // generic recursion
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') d(c, scope, fscope);
      } else if (typeof v.type === 'string') d(v, scope, fscope);
    }
  }

  function declareFunction(node, outer, selfName) {
    const fs = new Scope('function', outer, node);
    scopeOf.set(node, fs);
    if (selfName) declare(fs, selfName, 'fnexpr');
    node.params.forEach((p, i) => {
      for (const id of patternIdentifiers(p)) {
        const b = declare(fs, id.name, 'param');
        b.paramInfo = { fn: node, index: i, simple: p.type === 'Identifier', rest: p.type === 'RestElement' };
      }
      if (p.type !== 'Identifier') d(p, fs, fs); // defaults
    });
    if (node.body.type === 'BlockStatement') {
      for (const s of node.body.body) d(s, fs, fs);
    } else d(node.body, fs, fs);
  }

  for (const s of ast.body) d(s, program, program);

  // `export { a, b as c }` and `export default ident` — resolve once all bindings exist.
  for (const list of ctx.exportLists) declareExported(list.node, list.names, list.defaultExpr ? 'default-expr' : 'list');

  /* ------------------------------------------------------------ pass 2 */

  let cur = null; // current candidate (innermost removable declaration)
  const stack = [];
  const push = (c) => {
    stack.push(cur);
    cur = c;
  };
  const pop = () => {
    cur = stack.pop();
  };

  function recordRef(node, scope, parent, key, mode) {
    const name = node.name;
    if (name === 'undefined' && !scope.lookup('undefined')) return;
    const b = scope.lookup(name);
    const ref = {
      node,
      from: cur,
      scope,
      mode,
      ctx,
      callNode: parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'callee' ? parent : null,
      nsMember: undefined,
    };
    if (b) {
      if (b.kind === 'import' && b.importInfo.imported === '*') {
        if (parent && parent.type === 'MemberExpression' && parent.object === node) {
          ref.nsMember = parent.computed ? (parent.property.type === 'Literal' ? String(parent.property.value) : null) : parent.property.name;
        } else ref.nsMember = null;
      }
      b.refs.push(ref);
      if (cur) cur.outRefs.add(b);
    } else {
      ref.name = name;
      ctx.globalRefs.push(ref);
      if (cur) cur.outGlobals.add(name);
    }
  }

  function bindingPattern(p, scope) {
    if (!p) return;
    switch (p.type) {
      case 'Identifier':
        return;
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'RestElement') bindingPattern(prop.argument, scope);
          else {
            if (prop.computed) visit(prop.key, scope, prop, 'key');
            bindingPattern(prop.value, scope);
          }
        }
        return;
      case 'ArrayPattern':
        for (const e of p.elements) bindingPattern(e, scope);
        return;
      case 'AssignmentPattern':
        bindingPattern(p.left, scope);
        visit(p.right, scope, p, 'right');
        return;
      case 'RestElement':
        bindingPattern(p.argument, scope);
        return;
      default:
        visit(p, scope, null, null);
    }
  }

  function assignPattern(p, scope, mode, rhs) {
    if (!p) return;
    switch (p.type) {
      case 'Identifier': {
        recordRef(p, scope, null, null, mode);
        const b = scope.lookup(p.name);
        if (b && rhs) b.assigned.push({ expr: rhs, scope });
        return;
      }
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'RestElement') assignPattern(prop.argument, scope, mode, null);
          else {
            if (prop.computed) visit(prop.key, scope, prop, 'key');
            assignPattern(prop.value, scope, mode, null);
          }
        }
        return;
      case 'ArrayPattern':
        for (const e of p.elements) assignPattern(e, scope, mode, null);
        return;
      case 'AssignmentPattern':
        assignPattern(p.left, scope, mode, null);
        visit(p.right, scope, p, 'right');
        return;
      case 'RestElement':
        assignPattern(p.argument, scope, mode, null);
        return;
      default:
        visit(p, scope, null, null);
    }
  }

  function functionName(node, parent) {
    if (node.id) return node.id.name;
    if (parent) {
      if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
      if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && !parent.computed) {
        return parent.key.name ?? String(parent.key.value ?? '');
      }
      if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && !parent.left.computed) {
        return parent.left.property.name;
      }
    }
    return '(anonymous)';
  }

  function newCand(props) {
    return ctx.newCandidate(props);
  }

  function visitStatements(list, scope) {
    let terminated = false;
    for (const stmt of list) {
      if (terminated && DEAD_ELIGIBLE.has(stmt.type) && !(stmt.type === 'ExpressionStatement' && stmt.directive) && !hasHoistedDeclaration(stmt)) {
        const cand = newCand({ kind: 'dead-code', name: 'Unreachable code', start: stmt.start, end: stmt.end, node: stmt, label: 'unreachable' });
        push(cand);
        visit(stmt, scope, null, null);
        pop();
        continue;
      }
      visit(stmt, scope, null, null);
      if (TERMINATORS.has(stmt.type)) terminated = true;
    }
  }

  function visitFunction(node, scope, parent, key) {
    const fs = scopeOf.get(node);
    ctx.fnParent.set(node, parent);
    ctx.functions.push({
      name: functionName(node, parent),
      kind: node.type === 'FunctionDeclaration' ? 'declaration' : node.type === 'ArrowFunctionExpression' ? 'arrow' : parent && parent.type === 'MethodDefinition' ? 'method' : 'expression',
      start: node.start,
      end: node.end,
      line: ctx.lineOf(node.start),
      async: !!node.async,
      generator: !!node.generator,
    });
    for (const p of node.params) bindingPattern(p, fs);
    if (node.body.type === 'BlockStatement') visitStatements(node.body.body, scopeOf.get(node.body) ?? fs);
    else visit(node.body, fs, node, 'body');
  }

  // Function bodies share the function scope, so BlockStatement bodies need no extra scope here.
  function visitBlockBody(block, fs) {
    visitStatements(block.body, fs);
  }

  function visit(node, scope, parent, key) {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        recordRef(node, scope, parent, key, 'read');
        return;
      case 'Literal':
        hooks.onLiteral(node, ctx, parent);
        return;
      case 'TemplateLiteral':
        hooks.onTemplate(node, ctx, scope, parent);
        for (const e of node.expressions) visit(e, scope, node, 'expressions');
        return;
      case 'MemberExpression':
        visit(node.object, scope, node, 'object');
        if (node.computed) visit(node.property, scope, node, 'property');
        hooks.onMember(node, ctx, scope, parent);
        return;
      case 'Property':
        if (node.computed) visit(node.key, scope, node, 'key');
        else if (node.key.type === 'Literal' && typeof node.key.value === 'string') hooks.onLiteral(node.key, ctx, node);
        visit(node.value, scope, node, 'value');
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope, node, 'key');
        if (node.value) visit(node.value, scope, node, 'value');
        return;
      case 'StaticBlock': {
        const fs = scopeOf.get(node) ?? scope;
        visitStatements(node.body, fs);
        return;
      }
      case 'LabeledStatement':
        visit(node.body, scope, node, 'body');
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      case 'MetaProperty':
        return;
      case 'Program':
        visitStatements(node.body, scope);
        return;
      case 'BlockStatement': {
        const bs = scopeOf.get(node) ?? scope;
        visitStatements(node.body, bs);
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope, node, 'discriminant');
        const bs = scopeOf.get(node) ?? scope;
        for (const c of node.cases) {
          if (c.test) visit(c.test, bs, c, 'test');
          visitStatements(c.consequent, bs);
        }
        return;
      }
      case 'ForStatement': {
        const bs = scopeOf.get(node) ?? scope;
        visit(node.init, bs, node, 'init');
        visit(node.test, bs, node, 'test');
        visit(node.update, bs, node, 'update');
        visit(node.body, bs, node, 'body');
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const bs = scopeOf.get(node) ?? scope;
        if (node.left.type === 'VariableDeclaration') {
          for (const dd of node.left.declarations) bindingPattern(dd.id, bs);
        } else assignPattern(node.left, bs, 'write', null);
        visit(node.right, bs, node, 'right');
        visit(node.body, bs, node, 'body');
        return;
      }
      case 'CatchClause': {
        const cs = scopeOf.get(node) ?? scope;
        bindingPattern(node.param, cs);
        visit(node.body, cs, node, 'body');
        return;
      }
      case 'ImportDeclaration': {
        for (const spec of node.specifiers) {
          const b = program.bindings.get(spec.local.name);
          const cand = newCand({
            kind: 'import',
            name: spec.local.name,
            binding: b,
            start: spec.start,
            end: spec.end,
            node: spec,
            removal: { type: 'import-specifier', decl: node, spec },
          });
          void cand;
        }
        return;
      }
      case 'ExportNamedDeclaration': {
        if (node.declaration) visit(node.declaration, scope, node, 'declaration');
        return;
      }
      case 'ExportDefaultDeclaration': {
        const decl = node.declaration;
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') visit(decl, scope, node, 'declaration');
        else if (decl.type === 'Identifier') recordRef(decl, scope, node, 'declaration', 'read'); // `export default foo` keeps foo alive
        else visit(decl, scope, node, 'declaration');
        return;
      }
      case 'ExportAllDeclaration':
        return;
      case 'VariableDeclaration': {
        const inFor = parent && (parent.type === 'ForStatement' || parent.type === 'ForInStatement' || parent.type === 'ForOfStatement');
        const exportNode = parent && parent.type === 'ExportNamedDeclaration' ? parent : null;
        const groupRange = exportNode || node;
        const group = { start: groupRange.start, end: groupRange.end, declarators: [] };
        for (const dd of node.declarations) {
          const simple = dd.id.type === 'Identifier';
          let cand = null;
          if (simple && !inFor) {
            const target = node.kind === 'var' ? nearestVarScope(scope) : scope;
            const b = target.bindings.get(dd.id.name);
            const pure = !dd.init || isPureExpression(dd.init);
            const isFn = dd.init && (dd.init.type === 'FunctionExpression' || dd.init.type === 'ArrowFunctionExpression');
            const entry = { start: dd.start, end: dd.end, cand: null };
            group.declarators.push(entry);
            cand = newCand({
              kind: isFn ? 'function' : dd.init && dd.init.type === 'ClassExpression' ? 'class' : 'variable',
              name: dd.id.name,
              binding: b,
              start: dd.start,
              end: dd.end,
              node: dd,
              fnStart: isFn ? dd.init.start : undefined,
              pure,
              impureReason: pure ? null : 'initializer may have side effects',
              removal: { type: 'declarator', group, entry },
            });
            entry.cand = cand;
          }
          if (cand) push(cand);
          bindingPattern(dd.id, scope);
          visit(dd.init, scope, dd, 'init');
          if (cand) pop();
        }
        return;
      }
      case 'FunctionDeclaration': {
        const b = node.id ? scope.lookup(node.id.name) : null;
        const exportNode = parent && (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') ? parent : null;
        const range = exportNode || node;
        const cand = newCand({
          kind: 'function',
          name: node.id ? node.id.name : 'default',
          binding: b,
          start: range.start,
          end: range.end,
          node,
          fnStart: node.start,
          exportNode,
          pure: true,
          removal: { type: 'statement' },
        });
        push(cand);
        visitFunction(node, scope, parent, key);
        pop();
        return;
      }
      case 'ClassDeclaration': {
        const b = node.id ? scope.lookup(node.id.name) : null;
        const exportNode = parent && (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') ? parent : null;
        const range = exportNode || node;
        const pure = isPureClass(node);
        const cand = newCand({
          kind: 'class',
          name: node.id ? node.id.name : 'default',
          binding: b,
          start: range.start,
          end: range.end,
          node,
          exportNode,
          pure,
          impureReason: pure ? null : 'class has static initialisers or a side-effectful heritage',
          removal: { type: 'statement' },
        });
        push(cand);
        visit(node.superClass, scope, node, 'superClass');
        visit(node.body, scope, node, 'body');
        pop();
        return;
      }
      case 'ClassExpression': {
        const cs = scopeOf.get(node) ?? scope;
        visit(node.superClass, cs, node, 'superClass');
        visit(node.body, cs, node, 'body');
        return;
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node, scope, parent, key);
        return;
      case 'AssignmentExpression': {
        const mode = node.operator === '=' ? 'write' : 'readwrite';
        if (node.left.type === 'Identifier' || node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
          assignPattern(node.left, scope, mode, node.operator === '=' ? node.right : null);
          // `html += '<li>…</li>'`: keep the appended piece so the string resolver can see it.
          if (node.operator === '+=' && node.left.type === 'Identifier') {
            const b = scope.lookup(node.left.name);
            if (b) (b.appended ||= []).push({ expr: node.right, scope });
          }
        } else visit(node.left, scope, node, 'left');
        visit(node.right, scope, node, 'right');
        hooks.onAssign(node, ctx, scope);
        return;
      }
      case 'UpdateExpression':
        if (node.argument.type === 'Identifier') recordRef(node.argument, scope, node, 'argument', 'readwrite');
        else visit(node.argument, scope, node, 'argument');
        return;
      case 'CallExpression': {
        visit(node.callee, scope, node, 'callee');
        for (const a of node.arguments) visit(a, scope, node, 'arguments');
        hooks.onCall(node, ctx, scope, parent);
        return;
      }
      case 'NewExpression': {
        visit(node.callee, scope, node, 'callee');
        for (const a of node.arguments) visit(a, scope, node, 'arguments');
        hooks.onNew(node, ctx, scope);
        return;
      }
      case 'ImportExpression': {
        visit(node.source, scope, node, 'source');
        hooks.onImportExpression(node, ctx, scope);
        return;
      }
      case 'BinaryExpression': {
        visit(node.left, scope, node, 'left');
        visit(node.right, scope, node, 'right');
        if (node.operator === '+' && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+')) {
          hooks.onBinaryConcat(node, ctx, scope);
        }
        return;
      }
      case 'IfStatement': {
        const t = constantTruthiness(node.test);
        if (t === false && !hasHoistedDeclaration(node.consequent)) {
          const alt = node.alternate;
          const cand = newCand({
            kind: 'dead-code',
            name: 'if (false) branch',
            start: node.start,
            end: node.end,
            node,
            label: 'constant-false branch',
            replacement: alt ? text.slice(alt.start, alt.end) : '',
          });
          visit(node.test, scope, node, 'test');
          push(cand);
          visit(node.consequent, scope, node, 'consequent');
          pop();
          if (alt) visit(alt, scope, node, 'alternate');
          return;
        }
        if (t === true && node.alternate && !hasHoistedDeclaration(node.alternate)) {
          const cand = newCand({
            kind: 'dead-code',
            name: 'else branch of if (true)',
            start: node.consequent.end,
            end: node.end,
            node: node.alternate,
            label: 'constant-true else',
          });
          visit(node.test, scope, node, 'test');
          visit(node.consequent, scope, node, 'consequent');
          push(cand);
          visit(node.alternate, scope, node, 'alternate');
          pop();
          return;
        }
        visit(node.test, scope, node, 'test');
        visit(node.consequent, scope, node, 'consequent');
        visit(node.alternate, scope, node, 'alternate');
        return;
      }
      case 'JSXElement': {
        visit(node.openingElement, scope, node, 'openingElement');
        for (const c of node.children) visit(c, scope, node, 'children');
        return;
      }
      case 'JSXOpeningElement': {
        const n = node.name;
        if (n.type === 'JSXIdentifier') {
          if (/^[A-Z_$]/.test(n.name)) recordRef({ type: 'Identifier', name: n.name, start: n.start, end: n.end }, scope, null, null, 'read');
          else {
            ctx.jsxTags.add(n.name.toLowerCase());
            hooks.onJsxElement(node, ctx);
          }
        } else if (n.type === 'JSXMemberExpression') {
          let o = n;
          while (o.type === 'JSXMemberExpression') o = o.object;
          if (o.type === 'JSXIdentifier') recordRef({ type: 'Identifier', name: o.name, start: o.start, end: o.end }, scope, null, null, 'read');
        }
        for (const a of node.attributes) visit(a, scope, node, 'attributes');
        return;
      }
      case 'JSXAttribute': {
        hooks.onJsxAttribute(node, ctx, scope);
        if (node.value) visit(node.value, scope, node, 'value');
        return;
      }
      case 'JSXExpressionContainer':
        visit(node.expression, scope, node, 'expression');
        return;
      case 'JSXSpreadAttribute':
        visit(node.argument, scope, node, 'argument');
        return;
      case 'JSXClosingElement':
      case 'JSXText':
      case 'JSXEmptyExpression':
      case 'JSXIdentifier':
      case 'JSXNamespacedName':
        return;
      default:
        break;
    }
    for (const k in node) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c, scope, node, k);
      } else if (typeof v.type === 'string') visit(v, scope, node, k);
    }
  }

  function nearestVarScope(scope) {
    let s = scope;
    while (s && !s.isVarScope) s = s.parent;
    return s || program;
  }

  visit(ast, program, null, null);

  // Classic JSX runtimes reference React (or the @jsx pragma) implicitly.
  if (ctx.hasJsx) {
    const names = new Set(['React']);
    for (const c of ctx.comments) {
      const m = /@jsx\s+([A-Za-z_$][\w$.]*)/.exec(c.value);
      if (m) names.add(m[1].split('.')[0]);
    }
    for (const n of names) {
      const b = program.lookup(n);
      if (b) b.refs.push({ node: null, from: null, scope: program, mode: 'read', ctx, callNode: null, nsMember: undefined });
    }
  }

  void visitBlockBody;
}
