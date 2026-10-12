import { memo } from 'react';
import { useApp } from '../hooks/appStore.js';
import { SAFETY_WARNING } from '../utils/constants.js';
import { formatBytes, formatNumber, formatPercent } from '../utils/format.js';
import { Icon } from './Icons.jsx';

/** A short list of counts, one per hairline row. */
function Facts({ items }) {
  return (
    <dl className="dash__facts">
      {items.map(([label, value, tone, hint]) => (
        <div key={label} className={`fact${tone ? ` fact--${tone}` : ''}`} title={hint}>
          <dt>{label}</dt>
          <dd>{formatNumber(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The headline of a result: the reduction, big, with one plain sentence under it. */
function Lead({ eyebrow, reduction, children }) {
  return (
    <div className="dash__lead">
      <p className="dash__eyebrow">{eyebrow}</p>
      <p className="dash__big">
        {formatPercent(reduction)}
        <span className="dash__unit">{reduction > 0 ? 'smaller' : 'no change'}</span>
      </p>
      <p className="dash__line">{children}</p>
    </div>
  );
}

function SegmentBar({ segments }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="segbar" role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}>
      {segments.map(
        (s) =>
          s.value > 0 && (
            <i key={s.label} className={`segbar__seg segbar__seg--${s.tone}`} style={{ flexGrow: s.value / total }} title={`${s.label}: ${s.value}`} />
          ),
      )}
    </div>
  );
}

const CssPanel = memo(function CssPanel({ css }) {
  const s = css.selectors;
  return (
    <section className="dash" aria-label="CSS results">
      <Lead eyebrow={`CSS · ${css.files} ${css.files === 1 ? 'stylesheet' : 'stylesheets'}`} reduction={css.reduction}>
        <b>{formatBytes(css.originalBytes)}</b> → <b>{formatBytes(css.purifiedBytes)}</b>.{' '}
        {css.removedBytes > 0 ? `${formatBytes(css.removedBytes)} of CSS your site never uses is gone.` : 'Nothing could be removed safely.'}
      </Lead>
      <div className="dash__detail">
        <div className="dash__meter-head">
          <span>
            <strong>{formatNumber(s.used)}</strong> used selectors
          </span>
          <span>
            <strong>{formatNumber(s.unused)}</strong> unused of {formatNumber(s.total)}
          </span>
        </div>
        <SegmentBar
          segments={[
            { label: 'Used', value: s.used, tone: 'used' },
            { label: 'Unused · SAFE', value: s.safe, tone: 'safe' },
            { label: 'Unused · POTENTIAL', value: s.potential, tone: 'potential' },
            { label: 'Unused · UNKNOWN', value: s.unknown, tone: 'unknown' },
          ]}
        />
        <ul className="legend">
          <li><i className="dot dot--used" /> Used <b>{formatNumber(s.used)}</b></li>
          <li><i className="dot dot--safe" /> Removed <b>{formatNumber(s.safe)}</b></li>
          <li><i className="dot dot--potential" /> Kept, potentially unused <b>{formatNumber(s.potential)}</b></li>
          <li><i className="dot dot--unknown" /> Kept, unknown <b>{formatNumber(s.unknown)}</b></li>
        </ul>
        <Facts
          items={[
            ['Unused @keyframes', css.keyframes.unused, null, `of ${css.keyframes.total}`],
            ['Unused @font-face', css.fonts.unused, null, `of ${css.fonts.total}`],
            ['Unused variables', css.variables.unused, 'potential', `of ${css.variables.total} custom properties`],
          ]}
        />
      </div>
      {css.potentialBytes > 0 && (
        <p className="dash__note">
          <Icon name="info" size={14} />
          <span>{formatBytes(css.potentialBytes)} of potentially unused rules were kept, because they may still be used.</span>
        </p>
      )}
    </section>
  );
});

const JsPanel = memo(function JsPanel({ js }) {
  return (
    <section className="dash" aria-label="JavaScript results">
      <Lead eyebrow={`JavaScript · ${js.files} ${js.files === 1 ? 'script' : 'scripts'}${js.failedFiles > 0 ? ` · ${js.failedFiles} failed to parse` : ''}`} reduction={js.reduction}>
        <b>{formatBytes(js.originalBytes)}</b> → <b>{formatBytes(js.optimizedBytes)}</b>.{' '}
        {js.removedBytes > 0 ? `${formatBytes(js.removedBytes)} of code that never runs is gone.` : 'Nothing could be removed safely.'}
        {js.potentialBytes > 0 && ` Another ${formatBytes(js.potentialBytes)} is probably unused, so it was kept.`}
      </Lead>
      <div className="dash__detail">
        <Facts
          items={[
            ['Functions analyzed', js.functionsAnalyzed],
            ['Safe unused functions', js.safeFunctions, 'safe'],
            ['Potentially unused functions', js.potentiallyUnusedFunctions, 'potential', 'Not removed automatically'],
            ['Unused imports', js.unusedImports, 'safe'],
            ['Unused exports', js.unusedExports, 'potential'],
            ['Dead code blocks', js.deadCode, 'safe'],
          ]}
        />
      </div>
      <p className="callout callout--warn dash__note" role="note">
        <Icon name="warn" size={16} /> {SAFETY_WARNING}
      </p>
    </section>
  );
});

function Dashboard({ lang }) {
  const stats = useApp((s) => s.result?.stats);
  if (!stats) return null;
  return <div className="dashboard">{lang === 'js' ? <JsPanel js={stats.js} /> : <CssPanel css={stats.css} />}</div>;
}

export default memo(Dashboard);
