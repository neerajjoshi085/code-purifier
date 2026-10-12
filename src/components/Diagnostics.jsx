import { memo, useMemo, useState } from 'react';
import { actions, useApp } from '../hooks/appStore.js';
import { Icon } from './Icons.jsx';

const TITLES = {
  'css-parse': 'Invalid CSS',
  'js-parse': 'Invalid JavaScript',
  'html-parse': 'Invalid HTML',
  'missing-html': 'Missing HTML',
  unsupported: 'Unsupported file',
  zip: 'ZIP archive',
  'third-party': 'Scripts hosted elsewhere',
  'third-party-css': 'Stylesheets hosted elsewhere',
  'cdn-evidence': 'Scripts from public CDNs',
  site: 'Website download',
  read: 'Could not read file',
  'too-large': 'File too large',
  'nothing-to-purify': 'Nothing to purify',
};

function Diagnostics() {
  const issues = useApp((s) => s.issues);
  const report = useApp((s) => s.report);
  const [showAll, setShowAll] = useState(false);

  const items = useMemo(() => {
    const out = [];
    for (const i of issues) out.push({ severity: i.severity, title: TITLES[i.kind] || 'Problem', file: i.file, message: i.message, from: 'input' });
    if (report) {
      for (const e of report.errors) out.push({ severity: e.severity, title: TITLES[e.kind] || 'Problem', file: e.file, line: e.line, column: e.column, message: e.message, from: 'report' });
      for (const w of report.warnings) out.push({ severity: 'warning', title: 'Note', message: w, from: 'report' });
    }
    // errors first
    return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  }, [issues, report]);

  if (!items.length) return null;
  const errors = items.filter((i) => i.severity === 'error').length;
  const notes = items.filter((i) => i.severity === 'info').length;
  const warnings = items.length - errors - notes;
  const visible = showAll ? items : items.slice(0, 4);

  return (
    <section className={`diagnostics${errors ? ' diagnostics--error' : ''}`} aria-label="Problems found">
      <header className="diagnostics__head">
        <Icon name="warn" size={16} />
        <strong>
          {[
            errors ? `${errors} error${errors === 1 ? '' : 's'}` : '',
            warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
            notes ? `${notes} note${notes === 1 ? '' : 's'}` : '',
          ].filter(Boolean).join(' · ')}
        </strong>
        <span className="muted small">One broken file never stops the rest from being analysed.</span>
        {issues.length > 0 && (
          <button className="btn btn--sm btn--ghost diagnostics__dismiss" onClick={actions.dismissIssues}>
            Dismiss input issues
          </button>
        )}
      </header>
      <ul className="diagnostics__list">
        {visible.map((it, i) => (
          <li key={i} className={`diag diag--${it.severity}`}>
            <span className="diag__sev" aria-label={it.severity}>
              <Icon name={it.severity === 'error' ? 'close' : 'info'} size={13} strokeWidth={2.4} />
            </span>
            <div className="diag__body">
              <div className="diag__title">
                {it.title}
                {it.file && (
                  <span className="chip">
                    {it.file}
                    {it.line ? `:${it.line}` : ''}
                    {it.column ? `:${it.column}` : ''}
                  </span>
                )}
              </div>
              <div className="diag__msg">{it.message}</div>
            </div>
          </li>
        ))}
      </ul>
      {items.length > 4 && (
        <button className="btn btn--sm btn--ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}

export default memo(Diagnostics);
