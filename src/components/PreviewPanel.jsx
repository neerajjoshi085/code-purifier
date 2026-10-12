import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { useApp } from '../hooks/appStore.js';
import { buildPreviewDoc } from '../project/previewBuilder.js';
import { createAssetUrls } from '../project/previewAssets.js';
import '../styles/panels.css';

const VIEWPORTS = [
  { id: 'desktop', label: 'Desktop', width: '100%' },
  { id: 'tablet', label: 'Tablet', width: '820px' },
  { id: 'mobile', label: 'Mobile', width: '390px' },
];

const emptyLog = () => ({ console: [], errors: [], resources: [], loaded: false });

/** Messages that exist only in the purified run — these are the regressions worth looking at. */
function newIssues(purified, original) {
  const seen = new Set(original.errors.map((e) => e.message));
  const seenRes = new Set(original.resources.map((r) => r.url));
  return {
    errors: purified.errors.filter((e) => !seen.has(e.message)),
    resources: purified.resources.filter((r) => !seenRes.has(r.url)),
  };
}

function LogColumn({ title, log, tone }) {
  const [showAll, setShowAll] = useState(false);
  const items = [
    ...log.errors.map((e) => ({ level: 'error', text: `${e.message}${e.source ? `  (${String(e.source).split('/').pop()}:${e.line ?? '?'})` : ''}` })),
    ...log.resources.map((r) => ({ level: 'resource', text: `Failed to load <${String(r.tag).toLowerCase()}> ${r.url}` })),
    ...log.console.filter((c) => showAll || c.level === 'error' || c.level === 'warn').map((c) => ({ level: c.level, text: c.text })),
  ];
  return (
    <div className={`logcol logcol--${tone}`}>
      <div className="logcol__head">
        <strong>{title}</strong>
        <span className={`badge ${log.errors.length + log.resources.length ? 'badge--potential' : 'badge--safe'}`}>
          {log.errors.length} errors · {log.resources.length} failed loads
        </span>
        <label className="check check--sm logcol__all">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span>Show console.log</span>
        </label>
      </div>
      {items.length === 0 ? (
        <p className="muted small logcol__empty">{log.loaded ? 'No errors or warnings.' : 'Waiting for the page to load…'}</p>
      ) : (
        <ul className="logcol__list">
          {items.slice(0, 200).map((it, i) => (
            <li key={i} className={`logline logline--${it.level}`}>
              <span className="logline__lvl">{it.level === 'resource' ? 'load' : it.level}</span>
              <span className="logline__txt">{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PreviewPanel() {
  const report = useApp((s) => s.report);
  const result = useApp((s) => s.result);
  const project = useApp((s) => s.project);

  const pages = useMemo(() => (report ? report.units.filter((u) => u.kind === 'html' && u.ok) : []), [report]);
  const [page, setPage] = useState(null);
  const [mode, setMode] = useState('side'); // side | swipe
  const [viewport, setViewport] = useState('desktop');
  const [block, setBlock] = useState(false);
  const [split, setSplit] = useState(50);
  const [docs, setDocs] = useState(null);
  const [logs, setLogs] = useState({ original: emptyLog(), purified: emptyLog() });
  const [nonce, setNonce] = useState(0);
  const frames = useRef({ original: null, purified: null });

  const activePage = pages.find((p) => p.path === page)?.path || pages.find((p) => /(^|\/)index\.html?$/i.test(p.path))?.path || pages[0]?.path;

  // Build both documents (original / purified) whenever the inputs change.
  useEffect(() => {
    if (!activePage || !result || !report) return undefined;
    const files = new Map(project.map((f) => [f.path, f]));
    const assets = createAssetUrls(files);
    const base = Date.now().toString(36);
    const mk = (variant) =>
      buildPreviewDoc({
        htmlPath: activePage,
        files,
        textOf: (p) => {
          const r = result.files[p];
          if (variant === 'purified' && r && !r.failed && r.kind !== 'asset') return r.final;
          return files.get(p)?.text;
        },
        assetUrl: assets.assetUrl,
        previewId: `${base}:${variant}`,
        blockNetwork: block,
        rootDir: report.rootDir,
      });
    let original;
    let purified;
    try {
      original = mk('original');
      purified = mk('purified');
    } catch (err) {
      setDocs({ error: String(err?.message || err) });
      return () => assets.dispose();
    }
    setLogs({ original: emptyLog(), purified: emptyLog() });
    setDocs({ original, purified, base });
    return () => assets.dispose();
  }, [activePage, result, report, project, block, nonce]);

  // Collect console / error / resource messages from both iframes.
  useEffect(() => {
    const onMessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || typeof d.__cp !== 'string' || !docs?.base) return;
      const variant = e.source === frames.current.original?.contentWindow ? 'original' : e.source === frames.current.purified?.contentWindow ? 'purified' : null;
      if (!variant || !d.__cp.startsWith(docs.base)) return;
      setLogs((prev) => {
        const cur = prev[variant];
        const next = { ...cur };
        if (d.type === 'console') next.console = [...cur.console, { level: d.level, text: d.text }].slice(-300);
        else if (d.type === 'error') next.errors = [...cur.errors, { message: d.message, source: d.source, line: d.line }].slice(-100);
        else if (d.type === 'resource') next.resources = [...cur.resources, { tag: d.tag, url: d.url }].slice(-100);
        else if (d.type === 'load') next.loaded = true;
        return { ...prev, [variant]: next };
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [docs]);

  const regress = useMemo(() => newIssues(logs.purified, logs.original), [logs]);
  const setFrame = useCallback((variant) => (el) => (frames.current[variant] = el), []);

  if (!report || !result) return null;
  if (!pages.length) return <div className="empty">Add an HTML page to preview the original and purified site.</div>;

  const width = VIEWPORTS.find((v) => v.id === viewport).width;
  const sandbox = 'allow-scripts allow-forms allow-popups allow-modals';
  const frame = (variant, extra = {}) => (
    <iframe key={`${variant}:${docs?.base}`} ref={setFrame(variant)} className="preview__frame" title={`${variant} website`} sandbox={sandbox} srcDoc={docs?.[variant]?.html || ''} referrerPolicy="no-referrer" {...extra} />
  );

  const warnings = [...new Set([...(docs?.original?.warnings || []), ...(docs?.purified?.warnings || [])])];
  const missing = report.graph.missing;

  return (
    <div className="preview">
      <div className="preview__bar">
        <select className="select select--sm" value={activePage} onChange={(e) => setPage(e.target.value)} aria-label="Page to preview">
          {pages.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path}
            </option>
          ))}
        </select>
        <div className="seg" role="group" aria-label="Comparison mode">
          <button className={`seg__btn${mode === 'side' ? ' is-active' : ''}`} onClick={() => setMode('side')}>
            <Icon name="split" size={14} /> Side by side
          </button>
          <button className={`seg__btn${mode === 'swipe' ? ' is-active' : ''}`} onClick={() => setMode('swipe')}>
            <Icon name="layers" size={14} /> Swipe
          </button>
        </div>
        <div className="seg" role="group" aria-label="Viewport">
          {VIEWPORTS.map((v) => (
            <button key={v.id} className={`seg__btn${viewport === v.id ? ' is-active' : ''}`} onClick={() => setViewport(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <label className="check check--sm" title="Adds a Content-Security-Policy that blocks every network request from the preview">
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
          <span>Block network</span>
        </label>
        <button className="btn btn--sm" onClick={() => setNonce((n) => n + 1)}>
          <Icon name="refresh" size={14} /> Reload
        </button>
      </div>

      <p className="muted small preview__note">
        <Icon name="lock" size={13} /> Previews run in a sandboxed frame built from your files in this tab. Pages that reference external CDNs may load them unless you tick “Block network”.
      </p>

      {docs?.error ? (
        <div className="callout callout--warn">Could not build the preview: {docs.error}</div>
      ) : (
        <div className={`preview__stage preview__stage--${mode}`} style={{ '--vp': width }}>
          {mode === 'side' ? (
            <>
              <figure className="preview__col">
                <figcaption>
                  <span className="chip">Original</span>
                </figcaption>
                <div className="preview__viewport">{frame('original')}</div>
              </figure>
              <figure className="preview__col">
                <figcaption>
                  <span className="chip chip--accent">Purified</span>
                </figcaption>
                <div className="preview__viewport">{frame('purified')}</div>
              </figure>
            </>
          ) : (
            <figure className="preview__swipe">
              <figcaption>
                <span className="chip">Original (left)</span>
                <span className="chip chip--accent">Purified (right)</span>
              </figcaption>
              <div className="preview__viewport preview__viewport--swipe">
                <div className="preview__layer">{frame('original', { tabIndex: -1 })}</div>
                <div className="preview__layer preview__layer--top" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
                  {frame('purified', { tabIndex: -1 })}
                </div>
                <div className="preview__handle" style={{ left: `${split}%` }} aria-hidden="true" />
              </div>
              <input type="range" min="0" max="100" value={split} onChange={(e) => setSplit(+e.target.value)} className="preview__range" aria-label="Swipe position" />
            </figure>
          )}
        </div>
      )}

      <div className={`preview__verdict${regress.errors.length || regress.resources.length ? ' is-bad' : ''}`} role="status">
        {regress.errors.length || regress.resources.length ? (
          <>
            <Icon name="warn" size={16} /> The purified page has {regress.errors.length} new error{regress.errors.length === 1 ? '' : 's'} and {regress.resources.length} new failed load{regress.resources.length === 1 ? '' : 's'} that the original did not. Review them below, then keep the related findings.
          </>
        ) : (
          <>
            <Icon name="check" size={16} /> No new console errors or broken resources in the purified page compared with the original.
          </>
        )}
      </div>

      <div className="preview__logs">
        <LogColumn title="Original — console" log={logs.original} tone="original" />
        <LogColumn title="Purified — console" log={logs.purified} tone="purified" />
      </div>

      {(missing.length > 0 || warnings.length > 0) && (
        <div className="preview__warnings">
          <h4>Resource warnings</h4>
          <ul className="rows">
            {missing.slice(0, 40).map((m, i) => (
              <li key={`m${i}`} className="row row--warn">
                <Icon name="warn" size={13} /> <span className="mono">{m.ref}</span>
                <span className="muted small">
                  referenced from {m.from}
                  {m.line ? `:${m.line}` : ''} — not in the project
                </span>
              </li>
            ))}
            {warnings.slice(0, 20).map((w, i) => (
              <li key={`w${i}`} className="row">
                <Icon name="info" size={13} /> <span className="small">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default memo(PreviewPanel);
