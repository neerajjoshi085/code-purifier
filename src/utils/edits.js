/**
 * Range-based source editing. Purifiers never regenerate code from an AST when
 * they only need to delete things: they splice the original text, which keeps
 * formatting, comments, hacks and ordering exactly as the author wrote them.
 */

/**
 * @typedef {{ start: number, end: number, replacement?: string, meta?: any }} Edit
 */

/**
 * Applies non-overlapping edits. Edits fully contained in another edit are dropped.
 * @param {string} text
 * @param {Edit[]} edits
 * @returns {{ text: string, removed: {start:number,end:number,meta?:any}[], changed: {start:number,end:number}[] }}
 */
export function applyEdits(text, edits) {
  // Pure insertions sort before replacements that start at the same offset.
  const isInsert = (e) => e.end === e.start;
  const sorted = [...edits].sort((a, b) => a.start - b.start || (isInsert(a) ? -1 : isInsert(b) ? 1 : b.end - a.end));
  const accepted = [];
  let cursor = -1;
  for (const e of sorted) {
    if (e.start < cursor) continue; // contained in / overlapping the previous edit
    accepted.push(e);
    cursor = Math.max(cursor, e.end);
    if (e.end === e.start) cursor = e.end; // pure insertion
  }

  const out = [];
  const removed = [];
  const changed = [];
  let pos = 0;
  let outLen = 0;
  for (const e of accepted) {
    if (e.start > pos) {
      const chunk = text.slice(pos, e.start);
      out.push(chunk);
      outLen += chunk.length;
    }
    const replacement = e.replacement ?? '';
    if (e.end > e.start) removed.push({ start: e.start, end: e.end, meta: e.meta });
    if (replacement) {
      changed.push({ start: outLen, end: outLen + replacement.length });
      out.push(replacement);
      outLen += replacement.length;
    }
    pos = e.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return { text: out.join(''), removed, changed };
}

const isInlineSpace = (c) => c === 32 || c === 9;

/**
 * Widens a removal range so deleting a whole statement/rule that sits on its own
 * line(s) does not leave an indented blank line or a double blank line behind.
 */
export function expandRemovalRange(text, start, end) {
  let s = start;
  let e = end;

  // Only widen when the removed node is the sole content of its first line.
  let ls = s;
  while (ls > 0 && isInlineSpace(text.charCodeAt(ls - 1))) ls--;
  const atLineStart = ls === 0 || text.charCodeAt(ls - 1) === 10 || text.charCodeAt(ls - 1) === 13;

  let le = e;
  while (le < text.length && isInlineSpace(text.charCodeAt(le))) le++;
  const atLineEnd = le >= text.length || text.charCodeAt(le) === 10 || text.charCodeAt(le) === 13;

  if (atLineStart && atLineEnd) {
    s = ls;
    e = le;
    if (text.charCodeAt(e) === 13 && text.charCodeAt(e + 1) === 10) e += 2;
    else if (text.charCodeAt(e) === 10 || text.charCodeAt(e) === 13) e += 1;

    // Collapse a resulting double blank line.
    const prevBlank = isBlankLineBefore(text, s);
    const nextBlank = isBlankLineAt(text, e);
    if (prevBlank && nextBlank) {
      if (text.charCodeAt(e) === 13 && text.charCodeAt(e + 1) === 10) e += 2;
      else e += 1;
    }
  } else if (atLineEnd) {
    // `foo(); bar();` — trailing whitespace of the removed node goes with it.
    e = le;
  } else {
    // Something else follows on the same line: swallow whitespace after the node.
    let k = e;
    while (k < text.length && isInlineSpace(text.charCodeAt(k))) k++;
    e = k;
  }
  return { start: s, end: e };
}

function isBlankLineBefore(text, lineStart) {
  // Is the line right before `lineStart` empty?
  let i = lineStart - 1;
  if (i < 0) return true; // start of file counts as blank
  if (text.charCodeAt(i) === 10 && text.charCodeAt(i - 1) === 13) i--;
  if (text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) return false;
  const j = i - 1;
  if (j < 0) return true;
  return text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13;
}

function isBlankLineAt(text, pos) {
  let i = pos;
  while (i < text.length && isInlineSpace(text.charCodeAt(i))) i++;
  return i < text.length && (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13);
}

/**
 * How many whole lines a removal took out of the file (0 when it only cut part of a line).
 * Used to keep the two panes of the comparison view aligned while scrolling.
 */
export function removedLineCount(lineStarts, start, end, textLength) {
  const isStart = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] === pos) return mid;
      if (lineStarts[mid] < pos) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const s = isStart(start);
  if (s < 0) return 0;
  const e = isStart(end);
  if (e >= 0) return e - s;
  if (end >= textLength) return lineStarts.length - s;
  return 0;
}

/** Converts char ranges to merged 1-based inclusive line ranges. */
export function rangesToLineRanges(ranges, lineStarts, offsetToLine) {
  const out = [];
  for (const r of ranges) {
    const startLine = offsetToLine(lineStarts, r.start);
    const endLine = offsetToLine(lineStarts, Math.max(r.start, r.end - 1));
    out.push({ startLine, endLine, meta: r.meta });
  }
  return out;
}
