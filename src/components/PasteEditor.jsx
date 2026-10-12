import { memo, useState } from 'react';
import { actions, useApp } from '../hooks/appStore.js';
import { countLines } from '../utils/text.js';
import { formatBytes } from '../utils/format.js';
import { Icon } from './Icons.jsx';

const TABS = [
  { id: 'html', label: 'HTML', placeholder: '<!-- Paste your page markup here -->\n<div class="card">…</div>' },
  { id: 'css', label: 'CSS', placeholder: '/* Paste your stylesheet here */\n.card { … }' },
  { id: 'js', label: 'JavaScript', placeholder: '// Paste your script here\ndocument.querySelector(".card");' },
];

function PasteArea({ lang, placeholder }) {
  const value = useApp((s) => s.pasted[lang]);
  return (
    <div className="paste__area">
      <textarea
        className="paste__textarea"
        value={value}
        onChange={(e) => actions.setPasted(lang, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={`${lang.toUpperCase()} source`}
        rows={14}
      />
      <div className="paste__meta">
        {countLines(value)} lines · {formatBytes(new Blob([value]).size)}
      </div>
    </div>
  );
}

function PasteEditor() {
  const [tab, setTab] = useState('html');
  const filled = useApp((s) => s.pasted);
  const t = TABS.find((x) => x.id === tab);
  return (
    <div className="paste">
      <div className="paste__tabs" role="tablist" aria-label="Pasted source">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={`paste__tab${tab === x.id ? ' is-active' : ''}`} onClick={() => setTab(x.id)}>
            {x.label}
            {filled[x.id].trim() && <i className="paste__dot" aria-label="has content" />}
          </button>
        ))}
        <span className="paste__hint muted small">Analysis re-runs automatically a moment after you stop typing.</span>
        <button className="btn btn--sm" onClick={actions.analyzeNow}>
          <Icon name="play" size={14} /> Analyze now
        </button>
      </div>
      <PasteArea key={tab} lang={tab} placeholder={t.placeholder} />
    </div>
  );
}

export default memo(PasteEditor);
