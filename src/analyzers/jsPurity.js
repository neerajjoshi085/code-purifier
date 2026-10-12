/**
 * Conservative side-effect analysis for initialisers.
 *
 * `isPureExpression(node)` answers: "if this expression were evaluated and its
 * result thrown away, would the program observe any difference?" Anything we are
 * not sure about is reported as impure, which keeps the declaration around.
 */

const PURE_GLOBAL_CTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'Date', 'RegExp', 'Error', 'Symbol', 'Promise']);

/** DOM/Web reads that cannot mutate state. */
const PURE_METHODS = new Set([
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'getElementsByName',
  'createElement',
  'createElementNS',
  'createTextNode',
  'createDocumentFragment',
  'matchMedia',
  'getComputedStyle',
  'getAttribute',
  'hasAttribute',
  'getItem',
  'closest',
  'matches',
]);

export function isPureExpression(node, depth = 0) {
  if (!node) return true;
  if (depth > 12) return false;
  const rec = (n) => isPureExpression(n, depth + 1);
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'ThisExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'TemplateElement':
    case 'JSXText':
      return true;
    case 'TemplateLiteral':
      return node.expressions.every(rec);
    case 'UnaryExpression':
      return node.operator !== 'delete' && rec(node.argument);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return rec(node.left) && rec(node.right);
    case 'ConditionalExpression':
      return rec(node.test) && rec(node.consequent) && rec(node.alternate);
    case 'SequenceExpression':
      return node.expressions.every(rec);
    case 'ArrayExpression':
      return node.elements.every((e) => e === null || (e.type !== 'SpreadElement' && rec(e)));
    case 'ObjectExpression':
      return node.properties.every((p) => {
        if (p.type !== 'Property') return false; // spread may invoke getters
        if (p.computed && !rec(p.key)) return false;
        if (p.kind === 'get' || p.kind === 'set') return true; // defining accessors is pure
        return rec(p.value);
      });
    case 'ClassExpression':
      return isPureClass(node, depth);
    case 'NewExpression': {
      if (node.callee.type === 'Identifier' && PURE_GLOBAL_CTORS.has(node.callee.name)) {
        return node.arguments.every((a) => a.type !== 'SpreadElement' && rec(a));
      }
      return false;
    }
    case 'CallExpression': {
      const c = node.callee;
      if (c.type === 'Identifier' && (c.name === 'Symbol' || c.name === 'Array')) {
        return node.arguments.every((a) => a.type !== 'SpreadElement' && rec(a));
      }
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
        const name = c.property.name;
        if (PURE_METHODS.has(name) && node.arguments.every((a) => a.type !== 'SpreadElement' && rec(a))) return true;
        if (c.object.type === 'Identifier' && c.object.name === 'Object' && ['freeze', 'create', 'keys', 'values', 'entries'].includes(name)) {
          return node.arguments.every((a) => a.type !== 'SpreadElement' && rec(a));
        }
      }
      return false;
    }
    case 'JSXElement':
    case 'JSXFragment':
      return true; // React.createElement is pure at definition time
    default:
      // MemberExpression (getters/TypeError), Assignment, Update, Await, Yield, TaggedTemplate, …
      return false;
  }
}

export function isPureClass(node, depth = 0) {
  if (node.superClass && !isPureExpression(node.superClass, depth + 1)) return false;
  for (const m of node.body.body) {
    if (m.type === 'StaticBlock') return false;
    if (m.computed && !isPureExpression(m.key, depth + 1)) return false;
    if (m.type === 'PropertyDefinition' && m.static && m.value && !isPureExpression(m.value, depth + 1)) return false;
  }
  return true;
}

/** Returns true/false when the test is a compile-time constant, else undefined. */
export function constantTruthiness(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Literal':
      if (node.regex || node.bigint) return undefined;
      return !!node.value;
    case 'UnaryExpression':
      if (node.operator === '!') {
        const v = constantTruthiness(node.argument);
        return v === undefined ? undefined : !v;
      }
      if (node.operator === 'void' && node.argument.type === 'Literal') return false;
      return undefined;
    default:
      return undefined;
  }
}
