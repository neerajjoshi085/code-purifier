/**
 * Evidence collector hooks, called by the scope walker (jsScope.js).
 *
 * They recognise how JavaScript touches the DOM so that CSS usage can be judged
 * from the AST instead of from text matching:
 *
 *   document.querySelector('.menu')       classList.add('active')
 *   el.className = 'a b'                  el.setAttribute('data-x', …)
 *   el.innerHTML = '<div class="card">'   el.dataset.fooBar
 *   $('.x').addClass('y')                 <div className="card" />  (JSX)
 *
 * Literal arguments become evidence immediately. Non-literal arguments are
 * stored as "sinks" and resolved later (jsConstResolver.js), once the whole
 * project is known.
 */

const SELECTOR_METHODS = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches', 'webkitMatchesSelector', 'msMatchesSelector']);
const JQUERY_SELECTOR_METHODS = new Set(['find', 'children', 'filter', 'not', 'is', 'parents', 'parent', 'siblings', 'next', 'prev', 'nextAll', 'prevAll', 'has', 'closest', 'add', 'nextUntil', 'prevUntil', 'parentsUntil']);
const CLASS_METHODS = new Set(['addClass', 'removeClass', 'toggleClass', 'hasClass']);
const CLASSLIST_METHODS = new Set(['add', 'remove', 'toggle', 'contains', 'replace']);
const ATTR_NAME_METHODS = new Set(['setAttribute', 'getAttribute', 'hasAttribute', 'removeAttribute', 'toggleAttribute', 'setAttributeNS', 'getAttributeNS', 'attr', 'removeAttr', 'prop']);
const HTML_METHODS = new Set(['insertAdjacentHTML', 'createContextualFragment', 'parseFromString', 'write', 'writeln', 'html', 'append', 'prepend', 'after', 'before', 'appendTo', 'prependTo', 'replaceWith', 'wrap', 'wrapAll']);
const JQUERY_ROOTS = new Set(['$', 'jQuery']);
const CLASS_HELPERS = new Set(['classnames', 'classNames', 'clsx', 'cx', 'cn']);

export function propName(member) {
  if (member.type !== 'MemberExpression') return null;
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null;
  return member.property.type === 'Literal' && typeof member.property.value === 'string' ? member.property.value : null;
}

function camelToKebab(s) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/** `a.b.c` → "a.b.c" for simple member chains, else null. */
export function calleeText(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    const obj = calleeText(node.object);
    const p = propName(node);
    if (obj && p) return `${obj}.${p}`;
  }
  return null;
}

function addSink(ctx, kind, node, scope, how, extra) {
  ctx.sinks.push({ kind, node, scope, how, line: ctx.lineOf(node.start), ctx, ...extra });
}

function addString(ctx, value) {
  if (value.length === 0 || value.length > 4000) return;
  ctx.strings.add(value);
  if (value.length > 6 && value.includes('<') && /<[a-zA-Z][^>]*>/.test(value)) ctx.htmlStrings.push({ text: value });
}

export function onLiteral(node, ctx) {
  if (typeof node.value === 'string') addString(ctx, node.value);
  else if (node.regex) return;
}

export function onTemplate(node, ctx, scope, parent) {
  let hasLt = false;
  for (const q of node.quasis) {
    const cooked = q.value.cooked;
    if (cooked) {
      addString(ctx, cooked);
      if (cooked.includes('<')) hasLt = true;
    }
  }
  const inConcat = parent && parent.type === 'BinaryExpression' && parent.operator === '+';
  if (!inConcat) {
    if (hasLt) addSink(ctx, 'html', node, scope, 'template literal', { passive: true });
    if (node.expressions.length) addSink(ctx, 'concat', node, scope, 'template literal', { passive: true });
  }
}

export function onBinaryConcat(node, ctx, scope) {
  // Only the root of a `+` chain reaches here.
  let hasLt = false;
  const scan = (n) => {
    if (n.type === 'BinaryExpression' && n.operator === '+') {
      scan(n.left);
      scan(n.right);
    } else if (n.type === 'Literal' && typeof n.value === 'string' && n.value.includes('<')) hasLt = true;
    else if (n.type === 'TemplateLiteral' && n.quasis.some((q) => q.value.cooked && q.value.cooked.includes('<'))) hasLt = true;
  };
  scan(node);
  if (hasLt) addSink(ctx, 'html', node, scope, 'string concatenation', { passive: true });
  addSink(ctx, 'concat', node, scope, 'string concatenation', { passive: true });
}

export function onMember(node, ctx, scope) {
  const name = propName(node);
  const obj = node.object;
  // el.dataset.fooBar  →  [data-foo-bar]
  if (obj.type === 'MemberExpression' && propName(obj) === 'dataset') {
    if (name) ctx.attrNames.add('data-' + camelToKebab(name).toLowerCase());
    else addSink(ctx, 'attr-data', node.property, scope, 'dataset[...]');
  }
  // window.foo / globalThis.foo / self.foo → global reference by name
  if (obj.type === 'Identifier' && (obj.name === 'window' || obj.name === 'globalThis' || obj.name === 'self' || obj.name === 'top' || obj.name === 'parent')) {
    if (name) ctx.globalMemberRefs.add(name);
    else if (node.computed) {
      ctx.flags.dynamicGlobalAccess = true;
      ctx.dynamicGlobalLines.push(ctx.lineOf(node.start));
    }
  }
}

function recordListener(ctx, node, typeNode, handlerNode, how) {
  let type = '(dynamic)';
  if (typeNode && typeNode.type === 'Literal' && typeof typeNode.value === 'string') type = typeNode.value;
  let handler = 'inline function';
  if (handlerNode) {
    if (handlerNode.type === 'Identifier') handler = handlerNode.name;
    else if (handlerNode.type === 'MemberExpression') handler = calleeText(handlerNode) || 'member';
    else if (handlerNode.type === 'FunctionExpression' || handlerNode.type === 'ArrowFunctionExpression') handler = 'inline function';
    else handler = 'expression';
  }
  const callee = node.callee && node.callee.type === 'MemberExpression' ? node.callee.object : null;
  const target = callee ? (ctx.text.slice(callee.start, Math.min(callee.end, callee.start + 60)).replace(/\s+/g, ' ')) : '';
  ctx.eventListeners.push({ type, target, handler, how, line: ctx.lineOf(node.start) });
}

export function onAssign(node, ctx, scope) {
  const left = node.left;
  if (left.type !== 'MemberExpression') return;
  const name = propName(left);
  if (!name) return;
  switch (name) {
    case 'className':
      addSink(ctx, 'class', node.right, scope, 'className assignment', { adds: true });
      break;
    case 'id':
      addSink(ctx, 'id', node.right, scope, 'id assignment', { adds: true });
      break;
    case 'innerHTML':
    case 'outerHTML':
      addSink(ctx, 'html', node.right, scope, `${name} assignment`, { adds: true });
      break;
    case 'cssText':
      addSink(ctx, 'style', node.right, scope, 'style.cssText', { adds: true });
      break;
    case 'animation':
    case 'animationName':
    case 'fontFamily':
    case 'font':
      if (left.object.type === 'MemberExpression' && propName(left.object) === 'style') {
        addSink(ctx, 'style', node.right, scope, `style.${name}`, { adds: true });
      }
      break;
    default:
      if (/^on[a-z]+$/.test(name) && node.right && (node.right.type === 'Identifier' || node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression' || node.right.type === 'MemberExpression')) {
        recordListener(ctx, { start: node.start, callee: { type: 'MemberExpression', object: left.object } }, { type: 'Literal', value: name.slice(2) }, node.right, 'on* property');
      }
      break;
  }
}

export function onNew(node, ctx) {
  if (node.callee.type !== 'Identifier') return;
  const n = node.callee.name;
  if (n === 'Image') ctx.tagNames.add('img');
  else if (n === 'Option') ctx.tagNames.add('option');
  else if (n === 'Audio') ctx.tagNames.add('audio');
  else if (n === 'Worker' || n === 'SharedWorker') {
    const a = node.arguments[0];
    if (a && a.type === 'Literal' && typeof a.value === 'string') ctx.resourceRefs.push({ url: a.value, kind: 'worker', line: ctx.lineOf(node.start) });
    else if (a && a.type === 'NewExpression' && a.callee.type === 'Identifier' && a.callee.name === 'URL' && a.arguments[0]?.type === 'Literal') {
      ctx.resourceRefs.push({ url: String(a.arguments[0].value), kind: 'worker', line: ctx.lineOf(node.start) });
    }
  }
}

export function onImportExpression(node, ctx) {
  const s = node.source;
  if (s.type === 'Literal' && typeof s.value === 'string') ctx.imports.push({ source: s.value, node, kind: 'dynamic' });
  else {
    ctx.flags.dynamicImportUnresolved = true;
    ctx.imports.push({ source: null, node, kind: 'dynamic' });
  }
}

export function onJsxAttribute(node, ctx, scope) {
  if (node.name.type !== 'JSXIdentifier') return;
  const name = node.name.name;
  const lower = name.toLowerCase();
  const value = node.value;
  if (lower === 'classname' || lower === 'class') {
    if (value) {
      const target = value.type === 'JSXExpressionContainer' ? value.expression : value;
      if (target && target.type !== 'JSXEmptyExpression') addSink(ctx, 'class', target, scope, `JSX ${name}`, { adds: true });
    }
  } else if (lower === 'id') {
    if (value) {
      const target = value.type === 'JSXExpressionContainer' ? value.expression : value;
      if (target && target.type !== 'JSXEmptyExpression') addSink(ctx, 'id', target, scope, 'JSX id', { adds: true });
    }
  } else if (lower === 'style' || lower === 'htmlfor') {
    // nothing — inline style objects rarely reference keyframes by name via variables
  } else {
    ctx.attrNames.add(lower);
    if (value && value.type === 'Literal' && typeof value.value === 'string') ctx.attrValues.push({ name: lower, value: value.value });
  }
}

export function onJsxElement() {
  /* tag evidence is recorded by the scope walker (ctx.jsxTags) */
}

export function onCall(node, ctx, scope) {
  const callee = node.callee;
  const args = node.arguments;
  const text = calleeText(callee);
  if (text) ctx.callCounts.set(text, (ctx.callCounts.get(text) || 0) + 1);

  if (callee.type === 'Identifier') {
    const n = callee.name;
    if (JQUERY_ROOTS.has(n) && args[0]) {
      const a = args[0];
      if (a.type === 'Literal' && typeof a.value === 'string' && a.value.trim().startsWith('<')) addSink(ctx, 'html', a, scope, `${n}(html)`, { adds: true });
      else if (a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression' && a.type !== 'ObjectExpression') {
        addSink(ctx, 'selector', a, scope, `${n}(selector)`);
        recordSelector(ctx, node, n, a);
      }
    } else if (CLASS_HELPERS.has(n)) {
      for (const a of args) addSink(ctx, 'class', a, scope, `${n}()`, { adds: true });
    } else if (n === 'importScripts') {
      for (const a of args) if (a.type === 'Literal' && typeof a.value === 'string') ctx.resourceRefs.push({ url: a.value, kind: 'importScripts', line: ctx.lineOf(node.start) });
    } else if (n === 'require' && args[0] && args[0].type === 'Literal' && typeof args[0].value === 'string') {
      ctx.imports.push({ source: args[0].value, node, kind: 'require' });
    } else if (n === 'setTimeout' || n === 'setInterval') {
      if (args[0] && args[0].type === 'Literal' && typeof args[0].value === 'string') ctx.stringHandlers.push(args[0].value);
    }
    return;
  }
  if (callee.type !== 'MemberExpression') return;
  const method = propName(callee);
  if (!method) return;
  const obj = callee.object;

  if (SELECTOR_METHODS.has(method) && args[0]) {
    addSink(ctx, 'selector', args[0], scope, `${method}()`);
    recordSelector(ctx, node, method, args[0]);
  }
  switch (method) {
    case 'getElementById':
      if (args[0]) {
        addSink(ctx, 'id', args[0], scope, 'getElementById()');
        recordSelector(ctx, node, method, args[0], '#');
      }
      break;
    case 'getElementsByClassName':
      if (args[0]) {
        addSink(ctx, 'class', args[0], scope, 'getElementsByClassName()');
        recordSelector(ctx, node, method, args[0], '.');
      }
      break;
    case 'getElementsByTagName':
    case 'createElement':
      if (args[0]) addSink(ctx, 'tag', args[0], scope, `${method}()`, { adds: method === 'createElement' });
      break;
    case 'createElementNS':
      if (args[1]) addSink(ctx, 'tag', args[1], scope, 'createElementNS()', { adds: true });
      break;
    case 'getElementsByName':
      ctx.attrNames.add('name');
      break;
    case 'addEventListener':
    case 'removeEventListener':
      if (method === 'addEventListener') recordListener(ctx, node, args[0], args[1], 'addEventListener');
      break;
    case 'on':
    case 'one':
    case 'live':
    case 'delegate':
      if (args[0] && args[0].type === 'Literal' && typeof args[0].value === 'string') {
        const handler = args[args.length - 1];
        recordListener(ctx, node, args[0], handler, `.${method}()`);
        // delegated selector: $(document).on('click', '.btn', fn)
        if (args.length >= 3 && args[1].type !== 'ObjectExpression') addSink(ctx, 'selector', args[1], scope, `.${method}(selector)`);
      }
      break;
    case 'setProperty':
    case 'getPropertyValue':
    case 'removeProperty':
      if (args[0]) addSink(ctx, 'style', args[0], scope, `style.${method}()`, { adds: method === 'setProperty' });
      if (method === 'setProperty' && args[1]) addSink(ctx, 'style', args[1], scope, 'style.setProperty() value', { adds: true });
      break;
    default:
      break;
  }

  // el.classList.add('a', 'b')
  if (CLASSLIST_METHODS.has(method) && obj.type === 'MemberExpression' && propName(obj) === 'classList') {
    const take = method === 'toggle' || method === 'contains' ? args.slice(0, 1) : args;
    for (const a of take) addSink(ctx, 'class', a.type === 'SpreadElement' ? a.argument : a, scope, `classList.${method}()`, { adds: method === 'add' || method === 'toggle' || method === 'replace' });
    return;
  }
  if (CLASS_METHODS.has(method)) {
    const first = args[0];
    if (first && first.type !== 'FunctionExpression' && first.type !== 'ArrowFunctionExpression') addSink(ctx, 'class', first, scope, `${method}()`, { adds: method === 'addClass' || method === 'toggleClass' });
    return;
  }
  if (ATTR_NAME_METHODS.has(method) && args.length) {
    const nameArg = method === 'setAttributeNS' || method === 'getAttributeNS' ? args[1] : args[0];
    if (nameArg) {
      addSink(ctx, 'attr', nameArg, scope, `${method}()`, { adds: method === 'setAttribute' || method === 'setAttributeNS' || method === 'toggleAttribute' || (method === 'attr' && args.length > 1) });
      if (nameArg.type === 'Literal' && typeof nameArg.value === 'string') {
        const lower = nameArg.value.toLowerCase();
        const valueArg = args[1];
        if (method === 'setAttribute' && valueArg) {
          if (lower === 'class') addSink(ctx, 'class', valueArg, scope, 'setAttribute("class")', { adds: true });
          else if (lower === 'id') addSink(ctx, 'id', valueArg, scope, 'setAttribute("id")', { adds: true });
          else if (lower === 'style') addSink(ctx, 'style', valueArg, scope, 'setAttribute("style")', { adds: true });
          else if (valueArg.type === 'Literal' && typeof valueArg.value === 'string') ctx.attrValues.push({ name: lower, value: valueArg.value });
        }
      }
    }
    return;
  }
  if (HTML_METHODS.has(method) && !((method === 'write' || method === 'writeln') && !(obj.type === 'Identifier' && obj.name === 'document'))) {
    const htmlArg = method === 'insertAdjacentHTML' ? args[1] : args[0];
    if (htmlArg && htmlArg.type !== 'FunctionExpression' && htmlArg.type !== 'ArrowFunctionExpression') {
      // `.append(node)` is far more common than `.append('<div>')`; only treat as HTML when it can be a string.
      const isJqueryish = method === 'html' || method === 'append' || method === 'prepend' || method === 'after' || method === 'before' || method === 'appendTo' || method === 'prependTo' || method === 'replaceWith' || method === 'wrap' || method === 'wrapAll';
      if (!isJqueryish || htmlArg.type === 'Literal' || htmlArg.type === 'TemplateLiteral' || htmlArg.type === 'BinaryExpression') {
        addSink(ctx, 'html', htmlArg, scope, `${method}()`, { adds: true });
      }
    }
    return;
  }
  if (JQUERY_SELECTOR_METHODS.has(method) && args[0] && (args[0].type === 'Literal' || args[0].type === 'TemplateLiteral')) {
    // `.find('.x')` on arbitrary receivers; only literal strings are considered to avoid
    // misreading Array.prototype.find/filter callbacks.
    if (!(args[0].type === 'Literal' && typeof args[0].value !== 'string')) addSink(ctx, 'selector', args[0], scope, `.${method}()`, { weak: true });
  }
}

function recordSelector(ctx, callNode, method, arg, prefix = '') {
  let selector = '(dynamic)';
  if (arg.type === 'Literal' && typeof arg.value === 'string') selector = prefix + arg.value;
  else if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) selector = prefix + (arg.quasis[0].value.cooked ?? '');
  ctx.domSelectors.push({ method, selector, line: ctx.lineOf(callNode.start) });
}
