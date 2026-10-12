/** Text helpers shared by parsers, analyzers and purifiers. No DOM, no React. */

/** Offsets at which each line starts (index 0 => line 1). */
export function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 1-based line number containing `offset`. */
export function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function offsetToLoc(lineStarts, offset) {
  const line = offsetToLine(lineStarts, offset);
  return { line, column: offset - lineStarts[line - 1] + 1 };
}

/** UTF-8 byte length without allocating. */
export function byteLength(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function countLines(text) {
  if (!text) return 0;
  return buildLineIndex(text).length;
}

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cheap stable hash for ids (djb2). */
export function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function truncate(str, max = 80) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

export function collapseWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}
