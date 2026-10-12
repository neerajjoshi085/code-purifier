import { lazy, memo, Suspense } from 'react';
import Dashboard from './Dashboard.jsx';
import { Icon } from './Icons.jsx';
import { actions, useApp } from '../hooks/appStore.js';

// Heavy panels are loaded on demand (code splitting).
const CodeCompare = lazy(() => import('./CodeCompare.jsx'));
const DownloadPanel = lazy(() => import('./DownloadPanel.jsx'));

const TABS = [
  { id: 'compare', label: 'Compare', icon: 'split' },
  { id: 'downloads', label: 'Download', icon: 'download' },
];

function PanelFallback() {
  return (
    <div className="panel-fallback" role="status">
      <span className="spinner" /> <span className="muted">Loading…</span>
    </div>
  );
}

function Results({ lang }) {
  // Only Compare and Download remain; anything else (e.g. a stale view) falls back to Compare.
  const stored = useApp((s) => s.view.tab);
  const tab = TABS.some((t) => t.id === stored) ? stored : 'compare';
  const purifying = useApp((s) => s.purifying);

  return (
    <section className={`results${purifying ? ' is-refreshing' : ''}`} aria-label="Results">
      <Dashboard lang={lang} />
      <div className="tabs" role="tablist" aria-label="Result views">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} className={`tabs__tab${tab === t.id ? ' is-active' : ''}`} onClick={() => actions.setView({ tab: t.id })}>
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
        {purifying && (
          <span className="tabs__busy">
            <span className="spinner" /> Updating…
          </span>
        )}
      </div>
      <div className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <Suspense fallback={<PanelFallback />}>
          {tab === 'compare' && <CodeCompare lang={lang} />}
          {tab === 'downloads' && <DownloadPanel lang={lang} />}
        </Suspense>
      </div>
    </section>
  );
}

export default memo(Results);
