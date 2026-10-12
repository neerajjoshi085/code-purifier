/**
 * CSS Parser — thin, tolerant wrapper around css-tree's parser.
 *
 * Only the standalone parser/generator/walker entry points are imported, so the
 * large mdn-data syntax tables are never bundled.
 */
import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';

export { generate, walk };

/**
 * @typedef {Object} ParsedCss
 * @property {any} ast        css-tree StyleSheet (with source positions)
 * @property {{message:string,line:number,column:number,offset:number}[]} errors
 * @property {{value:string,start:number,end:number}[]} comments
 */

/**
 * Parses CSS without ever throwing. Syntax problems are recovered by css-tree
 * (producing Raw nodes) and reported through `errors`.
 * @param {string} text
 * @returns {ParsedCss}
 */
export function parseCss(text, position = {}) {
  const errors = [];
  const comments = [];
  let ast;
  try {
    ast = parse(text, {
      ...position, // offset / line / column when parsing a fragment of a larger file
      positions: true,
      parseCustomProperty: true,
      onComment(value, loc) {
        comments.push({ value, start: loc.start.offset, end: loc.end.offset });
      },
      onParseError(err) {
        errors.push({
          message: String(err.message || err),
          line: err.line || 0,
          column: err.column || 0,
          offset: err.offset || 0,
        });
      },
    });
  } catch (err) {
    // css-tree is recovery-based; this is a last-resort guard.
    errors.push({ message: String(err?.message || err), line: 1, column: 1, offset: 0 });
    ast = null;
  }
  return { ast, errors, comments };
}

/** Serialises a node compactly (css-tree's default output is whitespace-minimal). */
export function generateCss(node) {
  return generate(node);
}
