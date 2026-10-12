/**
 * HTML Parser — htmlparser2 (pure JS, works inside Web Workers where DOMParser
 * is not available). Returns a lightweight DOM with source offsets.
 */
import { parseDocument } from 'htmlparser2';

/**
 * @typedef {{ type: string, name?: string, attribs?: Record<string,string>, children?: any[],
 *   data?: string, startIndex: number|null, endIndex: number|null, parent?: any }} HtmlNode
 */

/**
 * @param {string} text
 * @returns {{ document: HtmlNode|null, error: string|null }}
 */
export function parseHtml(text, options = {}) {
  try {
    const document = parseDocument(text, {
      withStartIndices: true,
      withEndIndices: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      decodeEntities: true,
      ...options,
    });
    return { document, error: null };
  } catch (err) {
    return { document: null, error: String(err?.message || err) };
  }
}

/** Depth-first walk over element-ish nodes (tag, script, style). */
export function walkElements(node, visit) {
  const children = node.children;
  if (!children) return;
  for (const child of children) {
    if (child.type === 'tag' || child.type === 'script' || child.type === 'style') {
      visit(child);
      walkElements(child, visit);
    } else if (child.children) {
      walkElements(child, visit);
    }
  }
}

/** Raw text content range of a <script>/<style> element, or null if empty. */
export function rawTextRange(element, source) {
  const kids = element.children;
  if (!kids || !kids.length) return null;
  const first = kids[0];
  const last = kids[kids.length - 1];
  if (first.startIndex == null || last.endIndex == null) return null;
  const start = first.startIndex;
  const end = last.endIndex + 1;
  return { start, end, text: source.slice(start, end) };
}
