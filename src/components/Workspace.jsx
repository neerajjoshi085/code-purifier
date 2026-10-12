import { memo, useEffect, useMemo, useRef } from 'react';
import Dropzone from './Dropzone.jsx';
import PasteEditor from './PasteEditor.jsx';
import UrlForm from './UrlForm.jsx';
import StatusBar from './StatusBar.jsx';
import Diagnostics from './Diagnostics.jsx';
import Results from './Results.jsx';
import { Icon } from './Icons.jsx';
import { actions, useApp } from '../hooks/appStore.js';
import { formatBytes, formatNumber } from '../utils/format.js';
import { scopeOf } from '../utils/scope.js';
import '../styles/workspace.css';

const KIND_NAME = { html: 'HTML', css: 'CSS', js: 'JS', asset: 'other' };

/**
 * The files of the current project. Each page lists only what it works on — HTML plus its own
 * language — like the rest of the page. The other language is still read (scripts decide which
 * CSS is used) but never changed here, so it is only mentioned in a note.
 */
function ProjectBar({ lang, children }) {
  const files = useApp((s) => s.files);
  const scope = scopeOf(lang);
  const otherKind = scope.lang === 'css' ? 'js' : 'css';
  const summary = useMemo(() => {
    const by = { html: 0, css: 0, js: 0, asset: 0 };
    let bytes = 0;
    for (const f of files) {
      by[f.kind]++;
      bytes += f.size;
    }
    return { by, bytes };
  }, [files]);
  const code = useMemo(() => files.filter((f) => scope.kinds.includes(f.kind)), [files, scope]);
  const shown = code.slice(0, 14);
  const others = summary.by[otherKind];
  return (
    <div className="projectbar">
      <div className="projectbar__sum">
        <strong>{formatNumber(files.length)}</strong> {files.length === 1 ? 'file' : 'files'} · {formatBytes(summary.bytes)}
        {['html', scope.lang, 'asset'].map((k) => summary.by[k] > 0 && <span key={k} className="chip">{summary.by[k]} {KIND_NAME[k]}</span>)}
        <span className="projectbar__spacer" />
        {children}
      </div>
      <ul className="projectbar__files">
        {shown.map((f) => (
          <li key={f.path} className={`pchip pchip--${f.kind}`}>
            <span className="pchip__name" title={f.path}>
              {f.path}
            </span>
            <button className="pchip__x" onClick={() => actions.removeFile(f.path)} aria-label={`Remove ${f.path}`}>
              <Icon name="close" size={12} strokeWidth={2.4} />
            </button>
          </li>
        ))}
        {code.length > shown.length && <li className="pchip pchip--more">+{code.length - shown.length} more</li>}
      </ul>
      {others > 0 && (
        <p className="projectbar__note muted small">
          {otherKind === 'js'
            ? `${formatNumber(others)} ${others === 1 ? 'script is' : 'scripts are'} also read, to see which classes they add at runtime. Scripts are never changed on this page.`
            : `${formatNumber(others)} ${others === 1 ? 'stylesheet is' : 'stylesheets are'} part of the project too. Stylesheets are never changed on this page.`}
        </p>
      )}
    </div>
  );
}

function ClearButton() {
  return (
    <button className="btn btn--sm btn--ghost" onClick={actions.clearProject}>
      <Icon name="trash" size={14} /> Clear
    </button>
  );
}

/** What was downloaded from the website address, with a way to start over. */
function SiteBar({ lang }) {
  const site = useApp((s) => s.site);
  return (
    <>
      <div className="sitebar">
        <span className="sitebar__icon" aria-hidden="true">
          <Icon name="globe" size={20} strokeWidth={1.5} />
        </span>
        <div className="sitebar__main">
          <a className="sitebar__host" href={site.url} target="_blank" rel="noreferrer noopener">
            {site.host} <Icon name="external" size={13} />
          </a>
          <span className="sitebar__meta">
            {site.pages} {site.pages === 1 ? 'page' : 'pages'} read · downloaded {formatBytes(site.bytes)}
          </span>
        </div>
        <button className="btn btn--sm" onClick={actions.clearProject}>
          Check another site
        </button>
      </div>
      <ProjectBar lang={lang} />
    </>
  );
}

const MODES = [
  { id: 'url', label: 'Website' },
  { id: 'upload', label: 'Upload files' },
  { id: 'paste', label: 'Paste code' },
];

function InputCard({ lang }) {
  const mode = useApp((s) => s.inputMode);
  const site = useApp((s) => s.site);
  const hasFiles = useApp((s) => s.files.length > 0);
  const pasteFilled = useApp((s) => !!(s.pasted.html || s.pasted.css || s.pasted.js));
  return (
    <div className="workbench">
      <div className="workbench__head">
        <div className="modes" role="tablist" aria-label="How to provide your code">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} className={`modes__btn${mode === m.id ? ' is-active' : ''}`} onClick={() => actions.setInputMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'paste' && pasteFilled && <ClearButton />}
      </div>
      {mode === 'url' && (site ? <SiteBar lang={lang} /> : <UrlForm lang={lang} />)}
      {mode === 'upload' &&
        (hasFiles ? (
          <>
            <ProjectBar lang={lang}>
              <ClearButton />
            </ProjectBar>
            <Dropzone compact />
          </>
        ) : (
          <Dropzone />
        ))}
      {mode === 'paste' && <PasteEditor />}
    </div>
  );
}

function Workspace({ lang }) {
  const hasReport = useApp((s) => !!s.report);
  const hasResult = useApp((s) => !!s.result);
  const fetchedRun = useApp((s) => (s.site ? s.runId : 0));
  const root = useRef(null);
  const seenRun = useRef(fetchedRun);

  // After a website has been downloaded, bring the analysis into view (not on first mount / route changes).
  useEffect(() => {
    if (fetchedRun && fetchedRun !== seenRun.current) root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    seenRun.current = fetchedRun;
  }, [fetchedRun]);

  return (
    <section id="workspace" ref={root} className="workspace container" aria-label="Purifier workspace">
      <InputCard lang={lang} />
      <StatusBar />
      <Diagnostics />
      {hasReport && hasResult && <Results lang={lang} />}
      {hasReport && !hasResult && (
        <div className="skeleton" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
    </section>
  );
}

export default memo(Workspace);
