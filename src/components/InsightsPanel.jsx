import { memo, useMemo, useState } from 'react';
import ConfidenceBadge from './ConfidenceBadge.jsx';
import { useApp } from '../hooks/appStore.js';
import { STATUS_LABEL } from '../utils/constants.js';
import { formatBytes, formatNumber } from '../utils/format.js';
import { scopeOf } from '../utils/scope.js';
import '../styles/panels.css';

const TABS_BY_LANG = {
  css: [
    { id: 'deps', label: 'Dependencies' },
    { id: 'css', label: 'CSS & DOM' },
  ],
  js: [
    { id: 'deps', label: 'Dependencies' },
    { id: 'js', label: 'JavaScript' },
  ],
};

function Section({ title, count, children, empty }) {
  return (
    <section className="insight">
      <header className="insight__head">
        <h4>{title}</h4>
        {count !== undefined && <span className="chip">{formatNumber(count)}</span>}
      </header>
      {count === 0 ? <p className="muted small insight__empty">{empty}</p> : children}
    </section>
  );
}

function Capped({ items, render, cap = 150 }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, cap);
  return (
    <>
      <ul className="rows">{shown.map(render)}</ul>
      {items.length > cap && (
        <button className="btn btn--sm btn--ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${formatNumber(items.length)}`}
        </button>
      )}
    </>
  );
}

const EDGE_LABEL = { stylesheet: 'stylesheet', script: 'script', module: 'module', import: 'import', dynamic: 'dynamic import', require: 'require', reexport: 're-export', asset: 'asset', img: 'image', link: 'link', source: 'source', video: 'video', audio: 'audio', iframe: 'iframe', embed: 'embed', worker: 'worker', importScripts: 'importScripts', track: 'track', input: 'input', object: 'object' };

function Dependencies({ graph, lang }) {
  const scope = scopeOf(lang);
  // Only the references that belong to this page's language (stylesheets, or scripts and imports).
  const view = useMemo(() => {
    const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    return {
      edges: graph.edges.filter((e) => e.scope === lang),
      missing: graph.missing.filter((m) => m.scope === lang),
      external: (graph.externalRefs || []).filter((x) => x.scope === lang).map((x) => x.url),
      orphans: graph.orphans.filter((p) => kindOf.get(p) === lang),
    };
  }, [graph, lang]);
  const byFrom = useMemo(() => {
    const m = new Map();
    for (const e of view.edges) (m.get(e.from) || m.set(e.from, []).get(e.from)).push(e);
    return m;
  }, [view]);
  const pages = graph.nodes.filter((n) => n.kind === 'html');
  const others = [...byFrom.keys()].filter((k) => !pages.some((p) => p.id === k)).sort();

  const renderTree = (from, depth, seen) => {
    const edges = byFrom.get(from) || [];
    return (
      <ul className="tree">
        {edges.map((e, i) => {
          const loop = seen.has(e.to);
          return (
            <li key={`${e.to}:${e.type}:${i}`}>
              <span className={`tree__type tree__type--${e.type}`}>{EDGE_LABEL[e.type] || e.type}</span>
              <span className="mono">{e.to}</span>
              {e.line > 0 && <span className="muted small"> :{e.line}</span>}
              {!loop && depth < 6 && byFrom.has(e.to) && renderTree(e.to, depth + 1, new Set([...seen, e.to]))}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="insights__grid">
      <Section title={`Pages and the ${scope.nouns} they load`} count={pages.length} empty="No HTML pages.">
        {pages.map((p) => (
          <div key={p.id} className="tree-root">
            <div className="tree-root__name mono">{p.id}</div>
            {byFrom.has(p.id) ? renderTree(p.id, 0, new Set([p.id])) : <p className="muted small">Loads no {scope.nouns} from this project.</p>}
          </div>
        ))}
        {others.length > 0 && (
          <>
            <h5 className="insight__sub">Other files with dependencies</h5>
            {others.map((o) => (
              <div key={o} className="tree-root">
                <div className="tree-root__name mono">{o}</div>
                {renderTree(o, 0, new Set([o]))}
              </div>
            ))}
          </>
        )}
      </Section>
      <div className="insights__col">
        <Section title="Missing resources" count={view.missing.length} empty="Every local reference resolves to a file in the project.">
          <Capped
            items={view.missing}
            render={(m, i) => (
              <li key={i} className="row row--warn">
                <span className="mono">{m.ref}</span>
                <span className="muted small">
                  from {m.from}
                  {m.line ? `:${m.line}` : ''} · {EDGE_LABEL[m.type] || m.type}
                </span>
              </li>
            )}
          />
        </Section>
        <Section title="Not referenced by anything" count={view.orphans.length} empty={`All ${scope.label} files are linked from somewhere.`}>
          <Capped items={view.orphans} render={(o) => <li key={o} className="row mono">{o}</li>} />
          <p className="muted small">Orphans are still analysed together with the rest of the project, but may be loaded dynamically or by other pages.</p>
        </Section>
        <Section title="External resources" count={view.external.length} empty="No external URLs or packages referenced.">
          <Capped items={view.external} render={(o) => <li key={o} className="row mono">{o}</li>} />
        </Section>
      </div>
    </div>
  );
}

function JsInsights({ insights }) {
  return (
    <div className="insights__grid">
      <Section title="Functions" count={insights.totals.functions} empty="No functions found.">
        <Capped
          items={insights.functions}
          cap={120}
          render={(f, i) => (
            <li key={i} className="row">
              <span className="mono row__main">{f.name}</span>
              <span className="chip">{f.kind}</span>
              <span className="muted small">
                {f.file}:{f.line}
              </span>
              {f.status && f.status !== 'USED' ? <ConfidenceBadge confidence={f.confidence} /> : <span className="badge badge--neutral">{f.status ? STATUS_LABEL[f.status] : 'not analysed'}</span>}
            </li>
          )}
        />
      </Section>
      <div className="insights__col">
        <Section title="Imports" count={insights.totals.imports} empty="No imports.">
          <Capped
            items={insights.imports}
            render={(m, i) => (
              <li key={i} className="row">
                <span className="mono row__main">{m.source ?? '(dynamic expression)'}</span>
                <span className="chip">{m.kind}</span>
                <span className="muted small">
                  {m.file}:{m.line}
                </span>
                {m.external && <span className="badge badge--neutral">external</span>}
              </li>
            )}
          />
        </Section>
        <Section title="Exports" count={insights.totals.exports} empty="No exports.">
          <Capped
            items={insights.exports}
            render={(m, i) => (
              <li key={i} className="row">
                <span className="mono row__main">{m.name}</span>
                <span className="chip">{m.kind}</span>
                <span className="muted small">{m.file}</span>
              </li>
            )}
          />
        </Section>
        <Section title="Most called functions" count={insights.calls.length} empty="No calls.">
          <Capped items={insights.calls} render={(c) => <li key={c.name} className="row"><span className="mono row__main">{c.name}()</span><span className="chip">{c.count}×</span></li>} />
        </Section>
      </div>
    </div>
  );
}

function CssInsights({ insights, universe, stats }) {
  const unresolved = Object.entries(universe.unresolved).flatMap(([kind, items]) => items.map((e) => ({ kind, e })));
  return (
    <div className="insights__grid">
      <Section title="What the analyzer saw" count={undefined}>
        <dl className="kv">
          <dt>HTML elements</dt><dd>{formatNumber(universe.elements)}</dd>
          <dt>Distinct classes in HTML</dt><dd>{formatNumber(universe.classes)}</dd>
          <dt>Distinct ids / tags</dt><dd>{formatNumber(universe.ids)} / {formatNumber(universe.tags)}</dd>
          <dt>Classes referenced from JavaScript</dt><dd>{formatNumber(universe.jsClasses)}</dd>
          <dt>Dynamic name fragments (e.g. <code>btn-*</code>)</dt><dd>{formatNumber(universe.patterns)}</dd>
          <dt>Event listeners</dt><dd>{formatNumber(insights.totals.listeners)}</dd>
          <dt>DOM queries</dt><dd>{formatNumber(insights.totals.selectors)}</dd>
        </dl>
        {universe.incomplete.length > 0 && (
          <p className="callout callout--warn">The analysis is incomplete ({universe.incomplete.slice(0, 2).join('; ')}). Absent selectors are reported as UNKNOWN.</p>
        )}
        <h5 className="insight__sub">Dynamic writes that could not be resolved</h5>
        {unresolved.length === 0 ? (
          <p className="muted small">None — every class/id/tag JavaScript can add was resolved or is covered by a fragment pattern.</p>
        ) : (
          <ul className="rows">
            {unresolved.slice(0, 40).map((u, i) => (
              <li key={i} className="row row--warn">
                <span className="chip">{u.kind}</span>
                <span className="mono row__main">{u.e}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div className="insights__col">
        <Section title="DOM queries in JavaScript" count={insights.totals.selectors} empty="No querySelector/getElementById calls found.">
          <Capped
            items={insights.selectors}
            render={(s, i) => (
              <li key={i} className="row">
                <span className="mono row__main">{s.selector}</span>
                <span className="chip">{s.method}</span>
                <span className="muted small">
                  {s.file}:{s.line}
                </span>
              </li>
            )}
          />
        </Section>
        <Section title="Event listeners" count={insights.totals.listeners} empty="No listeners found.">
          <Capped
            items={insights.listeners}
            render={(l, i) => (
              <li key={i} className="row">
                <span className="chip">{l.type}</span>
                <span className="mono row__main">{l.target ? `${l.target} → ` : ''}{l.handler}</span>
                <span className="muted small">
                  {l.file}:{l.line}
                </span>
              </li>
            )}
          />
        </Section>
        <Section title="Used selectors" count={stats.css.usedSelectors.length} empty="No used selectors.">
          <Capped items={stats.css.usedSelectors} cap={80} render={(s, i) => <li key={i} className="row mono">{s}</li>} />
        </Section>
      </div>
    </div>
  );
}

function InsightsPanel({ lang }) {
  const report = useApp((s) => s.report);
  const result = useApp((s) => s.result);
  const [tab, setTab] = useState('deps');
  const pageLang = lang === 'js' ? 'js' : 'css';
  const tabs = TABS_BY_LANG[pageLang];
  if (!report) return null;
  return (
    <div className="insights">
      <div className="seg" role="tablist" aria-label="Insights">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`seg__btn${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'deps' && <Dependencies graph={report.graph} lang={pageLang} />}
      {tab === 'js' && <JsInsights insights={report.insights} />}
      {tab === 'css' && result && <CssInsights insights={report.insights} universe={report.universe} stats={result.stats} />}
      <p className="muted small">
        {formatBytes(report.files.reduce((a, f) => a + f.size, 0))} across {report.files.length} files.
      </p>
    </div>
  );
}

export default memo(InsightsPanel);
