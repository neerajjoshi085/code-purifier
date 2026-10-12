import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodePane from './CodePane.jsx';
import FileSidebar from './FileSidebar.jsx';
import { actions, useApp } from '../hooks/appStore.js';
import { makeLineMapper } from '../utils/lineMap.js';
import { basename } from '../utils/path.js';
import { Icon } from './Icons.jsx';
import { scopeOf } from '../utils/scope.js';
import '../styles/code.css';

const ROW_H = 20;
const LANG_LABEL = { css: 'CSS', js: 'JavaScript', html: 'HTML' };

function useOriginalTexts() {
  const project = useApp((s) => s.project);
  return useMemo(() => {
    const m = new Map();
    for (const f of project) if (f.text !== undefined) m.set(f.path, f.text);
    return m;
  }, [project]);
}

function fileNameOf(displayPath, path, kind, inline) {
  if (!inline) return basename(path);
  const n = /#(style|script)-(\d+)/.exec(path);
  return `${basename(path.split('#')[0]).replace(/\.\w+$/, '')}-${n ? n[1] + n[2] : 'inline'}.${kind}`;
}

function CodeCompare({ lang: pageLang }) {
  const report = useApp((s) => s.report);
  const result = useApp((s) => s.result);
  const view = useApp((s) => s.view);
  const originals = useOriginalTexts();
  const [sync, setSync] = useState(true);
  const [showReadable, setShowReadable] = useState(false);
  const [flash, setFlash] = useState(null);
  const left = useRef(null);
  const right = useRef(null);
  // Where sync last moved each pane: the scroll event that move causes is an echo, not the user.
  const echo = useRef({ left: null, right: null });

  const scope = scopeOf(pageLang);
  const lang = scope.kinds.includes(view.lang) ? view.lang : pageLang;
  const units = useMemo(() => (report && result ? report.units.filter((u) => u.kind === lang && result.files[u.path]) : []), [report, result, lang]);
  const counts = useMemo(() => {
    const c = { css: 0, js: 0, html: 0 };
    if (report) for (const u of report.units) c[u.kind]++;
    return c;
  }, [report]);

  const selected = units.find((u) => u.path === view.file) || units.find((u) => result.files[u.path].removedRanges.length) || units[0];
  const res = selected && result ? result.files[selected.path] : null;

  const findingsByFile = useMemo(() => {
    const m = new Map();
    if (result) for (const f of result.findings) (m.get(f.file) || m.set(f.file, []).get(f.file)).push(f);
    return m;
  }, [result]);

  const originalText = selected ? (selected.inline ? res?.original : originals.get(selected.path)) ?? '' : '';
  const purifiedText = res ? (showReadable && res.minified ? res.output : res.final) : '';
  const isMinifiedView = !!res && res.minified && !showReadable;

  const leftMarks = useMemo(() => {
    const m = new Map();
    if (!res) return m;
    for (const r of res.removedRanges) for (let l = r.startLine; l <= r.endLine; l++) m.set(l, { kind: 'removed', confidence: r.confidence });
    for (const f of findingsByFile.get(res.displayPath) || []) {
      if (f.removed) continue;
      for (let l = f.startLine; l <= f.endLine; l++) if (!m.has(l)) m.set(l, { kind: 'flag', confidence: f.confidence });
    }
    return m;
  }, [res, findingsByFile]);

  const rightMarks = useMemo(() => {
    const m = new Map();
    if (!res || isMinifiedView) return m;
    for (const r of res.changedRanges) for (let l = r.startLine; l <= r.endLine; l++) m.set(l, { kind: 'changed', confidence: 'safe' });
    return m;
  }, [res, isMinifiedView]);

  const mapper = useMemo(() => makeLineMapper(res ? res.removedRanges : []), [res]);
  const canSync = sync && !isMinifiedView;

  // Follow the pane the user is scrolling. Programmatic moves are recognised by position (not by a
  // timer), so the follower's own scroll event never pushes the leader back — that ping-pong was
  // the jitter while scrolling.
  const follow = useCallback(
    (from, to, top, x, mapLine) => {
      const pending = echo.current[from];
      echo.current[from] = null;
      if (pending != null && Math.abs(top - pending) < 1) return;
      const target = (to === 'right' ? right : left).current;
      if (!canSync || !target) return;
      // Interpolate between where this line and the next one land in the other pane: across a
      // removed block the follower holds still (instead of wobbling within one row), and across
      // a jump it glides instead of snapping.
      const row = Math.floor(top / ROW_H);
      const frac = top / ROW_H - row;
      const a = mapLine(row + 1);
      const b = mapLine(row + 2);
      const applied = target.setScroll((a - 1 + frac * (b - a)) * ROW_H, x);
      echo.current[to] = applied;
    },
    [canSync],
  );
  const onLeftScroll = useCallback((top, x) => follow('left', 'right', top, x, mapper.toPurified), [follow, mapper]);
  const onRightScroll = useCallback((top, x) => follow('right', 'left', top, x, mapper.toOriginal), [follow, mapper]);

  // jump from the findings list
  useEffect(() => {
    if (!view.focusLine || !selected) return undefined;
    setFlash(view.focusLine);
    const t1 = setTimeout(() => left.current?.scrollToLine(view.focusLine, true), 30);
    const t2 = setTimeout(() => setFlash(null), 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [view.focusLine, view.focusFinding, selected?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!report || !result) return null;

  return (
    <div className="compare">
      <FileSidebar lang={pageLang} />
      <div className="compare__main">
        <div className="compare__bar">
          <div className="seg" role="tablist" aria-label="Language">
            {scope.kinds.map((id) => (
              <button key={id} role="tab" aria-selected={lang === id} className={`seg__btn${lang === id ? ' is-active' : ''}`} onClick={() => actions.setView({ lang: id, file: null, focusLine: null })} disabled={!counts[id]}>
                {LANG_LABEL[id]} <span className="seg__count">{counts[id]}</span>
              </button>
            ))}
          </div>
          <select className="select select--sm compare__select" aria-label="File" value={selected?.path || ''} onChange={(e) => actions.setView({ file: e.target.value, focusLine: null })}>
            {units.map((u) => (
              <option key={u.path} value={u.path}>
                {u.displayPath}
              </option>
            ))}
          </select>
          <span className="compare__spacer" />
          <ul className="legend legend--inline" aria-label="Legend">
            <li><i className="swatch swatch--removed" /> Removed</li>
            <li><i className="swatch swatch--flag-potential" /> Potential (kept)</li>
            <li><i className="swatch swatch--flag-unknown" /> Unknown (kept)</li>
            <li><i className="swatch swatch--changed" /> Changed</li>
          </ul>
          {res?.minified && (
            <label className="check check--sm">
              <input type="checkbox" checked={showReadable} onChange={(e) => setShowReadable(e.target.checked)} />
              <span>Show readable (before minify)</span>
            </label>
          )}
          <label className="check check--sm">
            <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />
            <span>Sync scroll</span>
          </label>
        </div>

        {!selected || !res ? (
          <div className="empty">No {lang.toUpperCase()} files in this project.</div>
        ) : (
          <>
            {res.notes.length > 0 && (
              <div className="callout callout--info" role="note">
                <Icon name="info" size={16} />
                <span>{res.notes.join(' ')}</span>
              </div>
            )}
            <div className="split">
              <CodePane
                key={`o:${selected.path}`}
                ref={left}
                tone="original"
                title="Original"
                lang={lang}
                text={originalText}
                marks={leftMarks}
                fileName={fileNameOf(selected.displayPath, selected.path, lang, selected.inline)}
                onScroll={onLeftScroll}
                flashLine={flash}
              />
              <CodePane
                key={`p:${selected.path}:${isMinifiedView}`}
                ref={right}
                tone="purified"
                title={isMinifiedView ? 'Purified · minified' : 'Purified'}
                lang={lang}
                text={purifiedText}
                marks={rightMarks}
                fileName={fileNameOf(selected.displayPath, selected.path, lang, selected.inline).replace(/(\.\w+)$/, isMinifiedView ? '.min$1' : '.purified$1')}
                onScroll={onRightScroll}
                notice={isMinifiedView ? 'Minified output — line-level highlights are off. Tick “Show readable” to compare line by line.' : null}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default memo(CodeCompare);
