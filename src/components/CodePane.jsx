import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import VirtualCode from './VirtualCode.jsx';
import { Icon } from './Icons.jsx';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { createHighlighter } from '../utils/highlight.js';
import { copyText, saveText } from '../utils/download.js';
import { formatBytes } from '../utils/format.js';
import { actions } from '../hooks/appStore.js';
import { byteLength } from '../utils/text.js';

const ROW_H = 20;
const CHUNK = 600; // lines longer than this are split into visual rows (minified output)
const MAX_MATCHES = 5000;

/** Builds a row index without allocating per line unless some line is very long. */
function buildRowIndex(lines) {
  let hasLong = false;
  for (const l of lines) {
    if (l.length > CHUNK * 2) {
      hasLong = true;
      break;
    }
  }
  if (!hasLong) return { count: lines.length, at: (i) => ({ line: i, start: 0, text: lines[i] }) };
  const map = [];
  for (let li = 0; li < lines.length; li++) {
    const len = lines[li].length;
    if (len <= CHUNK * 2) map.push([li, 0]);
    else for (let s = 0; s < len; s += CHUNK) map.push([li, s]);
  }
  return {
    count: map.length,
    at: (i) => {
      const [line, start] = map[i];
      const full = lines[line];
      return { line, start, text: full.length <= CHUNK * 2 ? full : full.slice(start, start + CHUNK) };
    },
  };
}

function tokenNode(t, text, key) {
  return t ? (
    <span key={key} className={`t-${t}`}>
      {text}
    </span>
  ) : (
    text
  );
}

/** Splits highlighted tokens around search matches. */
function renderTokens(tokens, ranges) {
  if (!ranges || !ranges.length) return tokens.map((t, i) => tokenNode(t.t, t.v, i));
  const out = [];
  let pos = 0;
  let r = 0;
  let k = 0;
  for (const tok of tokens) {
    const e = pos + tok.v.length;
    let s = pos;
    while (s < e) {
      while (r < ranges.length && ranges[r].e <= s) r++;
      if (r < ranges.length && ranges[r].s < e) {
        const rg = ranges[r];
        if (rg.s > s) {
          out.push(tokenNode(tok.t, tok.v.slice(s - pos, rg.s - pos), k++));
          s = rg.s;
        }
        const stop = Math.min(e, rg.e);
        out.push(
          <mark key={k++} className={rg.active ? 'is-active' : undefined}>
            {tokenNode(tok.t, tok.v.slice(s - pos, stop - pos), 0)}
          </mark>,
        );
        s = stop;
      } else {
        out.push(tokenNode(tok.t, tok.v.slice(s - pos), k++));
        s = e;
      }
    }
    pos = e;
  }
  return out;
}

/**
 * One side of the comparison: virtualised, syntax-highlighted, searchable code with
 * line numbers, per-line marks (removed / flagged / changed), copy and download.
 *
 * Imperative handle: { scrollToLine(line), setScroll(top, left), el }
 */
const CodePane = forwardRef(function CodePane({ title, tone, lang, text, marks, fileName, notice, onScroll, flashLine, chips }, ref) {
  const lines = useMemo(() => text.split(/\r\n|\r|\n/), [text]);
  const index = useMemo(() => buildRowIndex(lines), [lines]);
  const highlighter = useMemo(() => createHighlighter(lang, lines), [lang, lines]);
  const vc = useRef(null);

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(query, 180);

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line, center = true) {
        // `line` is 1-based; find the first row of that line
        let row = line - 1;
        if (index.count !== lines.length) {
          row = 0;
          for (let i = 0; i < index.count; i++) {
            if (index.at(i).line >= line - 1) {
              row = i;
              break;
            }
          }
        }
        vc.current?.scrollToRow(Math.max(0, row), center);
      },
      setScroll: (top, left) => vc.current?.setScroll(top, left),
      get el() {
        return vc.current?.el;
      },
    }),
    [index, lines.length],
  );

  // search -----------------------------------------------------------------
  const search = useMemo(() => {
    const q = debounced;
    if (!q) return { flat: [], byRow: new Map() };
    const needle = caseSensitive ? q : q.toLowerCase();
    const flat = [];
    const byRow = new Map();
    for (let i = 0; i < index.count && flat.length < MAX_MATCHES; i++) {
      const row = index.at(i).text;
      const hay = caseSensitive ? row : row.toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        const m = { row: i, s: at, e: at + needle.length };
        flat.push(m);
        (byRow.get(i) || byRow.set(i, []).get(i)).push(m);
        from = at + Math.max(1, needle.length);
        if (flat.length >= MAX_MATCHES) break;
      }
    }
    return { flat, byRow };
  }, [debounced, caseSensitive, index]);

  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    const m = search.flat[active];
    if (m) vc.current?.scrollToRow(m.row, true);
  }, [active, search]);

  const step = (d) => {
    if (!search.flat.length) return;
    setActive((a) => (a + d + search.flat.length) % search.flat.length);
  };

  // render -----------------------------------------------------------------
  const activeMatch = search.flat[active];
  const renderRow = useCallback(
    (i) => {
      const row = index.at(i);
      const lineNo = row.start === 0 ? row.line + 1 : '';
      const mark = marks?.get(row.line + 1);
      const tokens = row.start === 0 && row.text.length === lines[row.line].length ? highlighter.tokens(row.line) : [{ t: '', v: row.text }];
      const ranges = search.byRow.get(i)?.map((m) => ({ s: m.s, e: m.e, active: m === activeMatch }));
      const cls = ['vc-row'];
      if (mark) cls.push(`vc-row--${mark.kind}`, `vc-row--${(mark.confidence || 'safe').toLowerCase()}`);
      if (flashLine === row.line + 1 && row.start === 0) cls.push('vc-row--flash');
      return (
        <div key={i} className={cls.join(' ')} style={{ height: ROW_H }}>
          <span className="vc-ln" aria-hidden="true">
            {lineNo}
          </span>
          <span className="vc-code">{renderTokens(tokens, ranges)}</span>
        </div>
      );
    },
    [index, lines, highlighter, marks, search, activeMatch, flashLine],
  );

  const bytes = useMemo(() => byteLength(text), [text]);

  const onCopy = async () => {
    const ok = await copyText(text);
    actions.toast(ok ? `Copied ${title.toLowerCase()} code` : 'Copy failed — select the text manually', ok ? 'info' : 'error');
  };

  return (
    <div className={`pane pane--${tone}`}>
      <div className="pane__bar">
        <span className="pane__title">{title}</span>
        <span className="chip">{formatBytes(bytes)}</span>
        <span className="chip">{lines.length.toLocaleString()} lines</span>
        {chips}
        <span className="pane__spacer" />
        {searchOpen ? (
          <div className="pane__search">
            <Icon name="search" size={14} />
            <input
              autoFocus
              className="pane__search-input"
              value={query}
              placeholder={`Search ${title.toLowerCase()}…`}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') {
                  setSearchOpen(false);
                  setQuery('');
                }
              }}
              aria-label={`Search in ${title}`}
            />
            <button className={`pane__case${caseSensitive ? ' is-on' : ''}`} onClick={() => setCaseSensitive((v) => !v)} title="Match case" aria-pressed={caseSensitive}>
              Aa
            </button>
            <span className="pane__count">{debounced ? (search.flat.length ? `${active + 1}/${search.flat.length}${search.flat.length >= MAX_MATCHES ? '+' : ''}` : '0') : ''}</span>
            <button className="btn btn--ghost btn--icon btn--sm" onClick={() => step(-1)} aria-label="Previous match" disabled={!search.flat.length}>
              <Icon name="up" size={14} />
            </button>
            <button className="btn btn--ghost btn--icon btn--sm" onClick={() => step(1)} aria-label="Next match" disabled={!search.flat.length}>
              <Icon name="down" size={14} />
            </button>
            <button className="btn btn--ghost btn--icon btn--sm" onClick={() => { setSearchOpen(false); setQuery(''); }} aria-label="Close search">
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : (
          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setSearchOpen(true)} aria-label={`Search in ${title}`} title="Search">
            <Icon name="search" size={15} />
          </button>
        )}
        <button className="btn btn--ghost btn--icon btn--sm" onClick={onCopy} aria-label={`Copy ${title} code`} title="Copy">
          <Icon name="copy" size={15} />
        </button>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => saveText(text, fileName)} aria-label={`Download ${title} code`} title="Download">
          <Icon name="download" size={15} />
        </button>
      </div>
      {notice && <div className="pane__notice">{notice}</div>}
      <VirtualCode ref={vc} count={index.count} rowHeight={ROW_H} renderRow={renderRow} onScroll={onScroll} className={`vc--${lang}`} label={`${title} code`} />
    </div>
  );
});

export default memo(CodePane);
