import { memo, useMemo } from 'react';
import { actions, useApp } from '../hooks/appStore.js';
import { formatBytes, formatPercent, percent } from '../utils/format.js';
import { Icon } from './Icons.jsx';
import { scopeOf } from '../utils/scope.js';

const KIND_ORDER = { html: 0, css: 1, js: 2 };
const KIND_LABEL = { html: 'HTML', css: 'CSS', js: 'JS' };

function splitPath(display) {
  const hash = display.indexOf(' ');
  const base = hash >= 0 ? display.slice(0, hash) : display;
  const rest = hash >= 0 ? display.slice(hash) : '';
  const i = base.lastIndexOf('/');
  return { dir: i >= 0 ? base.slice(0, i + 1) : '', name: (i >= 0 ? base.slice(i + 1) : base) + rest };
}

function FileSidebar({ lang: pageLang }) {
  const report = useApp((s) => s.report);
  const result = useApp((s) => s.result);
  const view = useApp((s) => s.view);
  const kinds = scopeOf(pageLang).kinds;
  const units = useMemo(() => (report ? report.units.filter((u) => kinds.includes(u.kind)).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.displayPath.localeCompare(b.displayPath)) : []), [report, kinds]);
  if (!report) return null;

  return (
    <aside className="files" aria-label="Project files">
      <div className="files__head">
        <span className="eyebrow">Project</span>
        <span className="chip">{units.length}</span>
      </div>
      <ul className="files__list">
        {units.map((u) => {
          const r = result?.files[u.path];
          const reduction = r ? percent(Math.max(0, r.bytes.original - r.bytes.final), r.bytes.original) : 0;
          const active = view.file === u.path && view.lang === u.kind;
          const { dir, name } = splitPath(u.displayPath);
          return (
            <li key={u.path}>
              <button className={`file${active ? ' is-active' : ''}${u.inline ? ' file--inline' : ''}`} onClick={() => actions.setView({ lang: u.kind, file: u.path, focusLine: null })}>
                <span className={`file__kind file__kind--${u.kind}`}>{KIND_LABEL[u.kind]}</span>
                <span className="file__name" title={u.displayPath}>
                  {dir && <span className="file__dir">{dir}</span>}
                  {name}
                </span>
                {!u.ok ? (
                  <span className="file__state file__state--error" title="Could not be parsed — left unchanged">
                    <Icon name="warn" size={13} />
                  </span>
                ) : (
                  <span className="file__meta">
                    {r && reduction > 0 ? <b className="file__delta">−{formatPercent(reduction).replace('.0%', '%')}</b> : <span className="muted">{formatBytes(u.size)}</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

export default memo(FileSidebar);
