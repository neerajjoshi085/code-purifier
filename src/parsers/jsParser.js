/**
 * JavaScript Parser — acorn (+ acorn-jsx). Produces an ESTree AST with
 * `start`/`end` offsets, which the purifier uses for exact source splicing.
 */
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

const PlainParser = Parser;
const JsxParser = Parser.extend(jsx());

const BASE_OPTIONS = {
  ecmaVersion: 'latest',
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowImportExportEverywhere: false,
};

/**
 * @typedef {Object} ParsedJs
 * @property {boolean} ok
 * @property {any} [ast]
 * @property {{start:number,end:number,type:string,value:string}[]} [comments]
 * @property {'module'|'script'} [sourceType]
 * @property {boolean} [jsx]
 * @property {{message:string,line:number,column:number}} [error]
 */

/**
 * @param {string} text
 * @param {{ filename?: string, sourceType?: 'module'|'script'|'auto', jsx?: boolean|'auto' }} [opts]
 * @returns {ParsedJs}
 */
export function parseJs(text, opts = {}) {
  const filename = opts.filename || '';
  const wantJsx = opts.jsx ?? (filename.endsWith('.jsx') ? true : 'auto');
  // The type hint is a preference, not a constraint: a "classic" file that uses `import`
  // is still analysed (as a module) rather than rejected.
  const sourceTypes =
    opts.sourceType === 'module' || filename.endsWith('.mjs')
      ? ['module']
      : filename.endsWith('.cjs')
        ? ['script']
        : opts.sourceType === 'script'
          ? ['script', 'module']
          : ['module', 'script'];
  const jsxModes = wantJsx === 'auto' ? [false, true] : [wantJsx];

  let firstError = null;
  for (const sourceType of sourceTypes) {
    for (const useJsx of jsxModes) {
      const comments = [];
      try {
        const P = useJsx ? JsxParser : PlainParser;
        const ast = P.parse(text, {
          ...BASE_OPTIONS,
          sourceType,
          onComment(block, value, start, end) {
            comments.push({ type: block ? 'Block' : 'Line', value, start, end });
          },
        });
        // A script that parsed as a module without any import/export is still a classic script.
        return { ok: true, ast, comments, sourceType, jsx: useJsx };
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  }
  const loc = firstError?.loc || { line: 1, column: 0 };
  return {
    ok: false,
    error: {
      message: String(firstError?.message || firstError || 'Unknown parse error').replace(/\s*\(\d+:\d+\)$/, ''),
      line: loc.line,
      column: (loc.column ?? 0) + 1,
    },
  };
}

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw', 'sourceType', 'regex', 'bigint']);

/** Calls `enter(node, parent, key)` for every AST node. Return `false` to skip children. */
export function walkAst(root, enter) {
  const visit = (node, parent, key) => {
    if (enter(node, parent, key) === false) return;
    for (const k in node) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const c = v[i];
          if (c && typeof c.type === 'string') visit(c, node, k);
        }
      } else if (typeof v.type === 'string') {
        visit(v, node, k);
      }
    }
  };
  visit(root, null, null);
}

export const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
