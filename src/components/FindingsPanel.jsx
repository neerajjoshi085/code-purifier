import { memo, useCallback, useMemo, useState } from 'react';
import ConfidenceBadge from './ConfidenceBadge.jsx';
import VirtualCode from './VirtualCode.jsx';
import { Icon } from './Icons.jsx';
import { actions, useApp } from '../hooks/appStore.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { formatBytes, formatNumber } from '../utils/format.js';
import { saveText } from '../utils/download.js';
import { SAFETY_WARNINGS } from '../utils/constants.js';
import '../styles/panels.css';

const ROW_H = 74;

const KIND_LABEL = {
  rule: 'rule',
  selector: 'selector',
  keyframes: '@keyframes',
  'font-face': '@font-face',
  'custom-property': 'variable',
  property: '@property',
  function: 'function',
  class: 'class',
  variable: 'variable',
  import: 'import',
  'dead-code': 'dead code',
};

const FindingRow = memo(function FindingRow({ f, override }) {
  const manual = !!override;
  const canToggle = f.removable !== false;
  return (
    <div className={`finding${f.removed ? ' is-removed' : ''}`} style={{ height: ROW_H }}>
      <div className="finding__main">
        <div className="finding__top">
          <ConfidenceBadge confidence={f.confidence} />
          <span className="chip">{f.lang.toUpperCase()}</span>
          <span className="chip">{KIND_LABEL[f.kind] || f.kind}</span>
          {f.exported && <span className="chip">exported</span>}
          <span className="finding__name" title={f.name}>
            {f.name}
          </span>
        </div>
        <div className="finding__why" title={f.reasons.join(' · ')}>
          {f.reasons[0]}
          {f.reasons[1] ? ` · ${f.reasons[1]}` : ''}
        </div>
        <div className="finding__where">
          <button className="linklike" onClick={() => actions.focusFinding(f)} title="Show in the code comparison">
            {f.file}:{f.startLine}
          </button>
          {f.context && <span className="muted"> · {f.context}</span>}
          <span className="muted"> · {formatBytes(f.bytes)}</span>
        </div>
      </div>
      <div className="finding__actions">
        <span className={`finding__state${f.removed ? ' is-removed' : ''}`}>{f.removed ? 'Removed' : 'Kept'}</span>
        {manual && <span className="badge badge--neutral">manual</span>}
        {canToggle ? (
          <div className="mini-seg" role="group" aria-label="Decision">
            <button className={f.removed ? 'is-active is-remove' : ''} onClick={() => actions.setOverride(f.id, manual && override === 'remove' ? null : 'remove')} aria-pressed={f.removed}>
              Remove
            </button>
            <button className={!f.removed ? 'is-active is-keep' : ''} onClick={() => actions.setOverride(f.id, manual && override === 'keep' ? null : 'keep')} aria-pressed={!f.removed}>
              Keep
            </button>
          </div>
        ) : (
          <span className="muted small" title="Exported through an export list — remove it manually">
            manual only
          </span>
        )}
      </div>
    </div>
  );
});

function FindingsPanel({ lang: pageLang }) {
  const result = useApp((s) => s.result);
  const overrides = useApp((s) => s.options.overrides);
  const [conf, setConf] = useState('all');
  const [state, setState] = useState('all');
  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query, 200).trim().toLowerCase();

  // Each page lists only its own language's findings.
  const all = useMemo(() => (result?.findings ?? []).filter((f) => f.lang === pageLang), [result, pageLang]);
  const filtered = useMemo(
    () =>
      all.filter((f) => {
        if (conf !== 'all' && f.confidence !== conf) return false;
        if (state === 'removed' && !f.removed) return false;
        if (state === 'kept' && f.removed) return false;
        if (q && !(f.name.toLowerCase().includes(q) || f.file.toLowerCase().includes(q) || f.reasons.some((r) => r.toLowerCase().includes(q)))) return false;
        return true;
      }),
    [all, conf, state, q],
  );

  const counts = useMemo(() => {
    const c = { SAFE: 0, POTENTIAL: 0, UNKNOWN: 0, removed: 0 };
    for (const f of all) {
      c[f.confidence]++;
      if (f.removed) c.removed++;
    }
    return c;
  }, [all]);

  const renderRow = useCallback((i) => <FindingRow key={filtered[i].id} f={filtered[i]} override={overrides[filtered[i].id]} />, [filtered, overrides]);

  const bulk = (value) => {
    const next = { ...overrides };
    for (const f of filtered) if (f.removable !== false) next[f.id] = value;
    actions.setOptions({ overrides: next });
    actions.toast(`${value === 'remove' ? 'Marked' : 'Kept'} ${formatNumber(filtered.length)} findings`);
  };

  const exportReport = () => {
    const payload = { generatedAt: new Date().toISOString(), language: pageLang, stats: result.stats[pageLang], findings: all };
    saveText(JSON.stringify(payload, null, 2), 'code-purifier-report.json', 'application/json');
  };

  if (!result) return null;

  return (
    <div className="findings">
      <div className="findings__bar">
        <div className="seg" role="group" aria-label="Confidence filter">
          {[
            ['all', 'Any confidence'],
            ['SAFE', `Safe ${counts.SAFE}`],
            ['POTENTIAL', `Potential ${counts.POTENTIAL}`],
            ['UNKNOWN', `Unknown ${counts.UNKNOWN}`],
          ].map(([id, label]) => (
            <button key={id} className={`seg__btn${conf === id ? ' is-active' : ''}`} onClick={() => setConf(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="State filter">
          {[
            ['all', 'All'],
            ['removed', `Removed ${counts.removed}`],
            ['kept', 'Kept'],
          ].map(([id, label]) => (
            <button key={id} className={`seg__btn${state === id ? ' is-active' : ''}`} onClick={() => setState(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="findings__search">
          <Icon name="search" size={14} />
          <input className="input input--sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name, file or reason…" aria-label="Filter findings" />
        </div>
      </div>

      <div className="findings__summary">
        <span>
          <strong>{formatNumber(filtered.length)}</strong> of {formatNumber(all.length)} findings
        </span>
        <span className="findings__spacer" />
        <button className="btn btn--sm" onClick={() => bulk('remove')} disabled={!filtered.length} title="Remove every finding currently shown">
          Remove all shown
        </button>
        <button className="btn btn--sm" onClick={() => bulk('keep')} disabled={!filtered.length}>
          Keep all shown
        </button>
        <button className="btn btn--sm btn--ghost" onClick={exportReport}>
          <Icon name="download" size={14} /> Report (JSON)
        </button>
      </div>

      <p className="callout callout--warn" role="note">
        <Icon name="warn" size={16} />
        <span>
          {SAFETY_WARNINGS[pageLang]} Only <strong>Safe</strong> items are removed by default; use <em>Remove</em> on a row to override.
        </span>
      </p>

      {filtered.length === 0 ? (
        <div className="empty">{all.length ? 'No findings match these filters.' : 'Nothing to report — no unused code was detected.'}</div>
      ) : (
        <VirtualCode count={filtered.length} rowHeight={ROW_H} renderRow={renderRow} className="vl" label="Findings" />
      )}
      {result.findingsTruncated && <p className="muted small">The list is capped; export the report for the full data.</p>}
    </div>
  );
}

export default memo(FindingsPanel);
