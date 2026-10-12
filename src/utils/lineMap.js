/**
 * Maps line numbers between the original and the purified file so the two panes of
 * the comparison view stay aligned when whole lines were removed in between.
 *
 * @param {{ startLine: number, lines?: number }[]} removedRanges  (1-based, sorted by position)
 */
export function makeLineMapper(removedRanges) {
  const rs = removedRanges.filter((r) => r.lines > 0).sort((a, b) => a.startLine - b.startLine);
  const before = []; // lines removed before range i
  let acc = 0;
  for (const r of rs) {
    before.push(acc);
    acc += r.lines;
  }

  /** original line → purified line (a removed line maps to where it used to be) */
  function toPurified(line) {
    let lo = 0;
    let hi = rs.length - 1;
    let idx = -1; // last range starting at or before `line`
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid].startLine <= line) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx < 0) return line;
    const r = rs[idx];
    if (line < r.startLine + r.lines) return Math.max(1, r.startLine - before[idx]);
    return Math.max(1, line - before[idx] - r.lines);
  }

  /** purified line → original line */
  function toOriginal(line) {
    let removed = 0;
    for (let i = 0; i < rs.length; i++) {
      const purifiedStart = rs[i].startLine - before[i];
      if (line >= purifiedStart) removed = before[i] + rs[i].lines;
      else break;
    }
    return line + removed;
  }

  return { toPurified, toOriginal, active: rs.length > 0 };
}
