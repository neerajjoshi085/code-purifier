import { memo } from 'react';
import { actions, useApp } from '../hooks/appStore.js';
import { Icon } from './Icons.jsx';

function StatusBar() {
  const status = useApp((s) => s.status);
  const progress = useApp((s) => s.progress);
  const purifying = useApp((s) => s.purifying);
  const engineError = useApp((s) => s.engineError);

  if (engineError) {
    return (
      <div className="statusbar statusbar--error" role="alert">
        <Icon name="warn" size={18} />
        <div className="statusbar__text">
          <strong>The analysis engine hit an unexpected problem.</strong>
          <span className="muted">{engineError}</span>
        </div>
        <button className="btn btn--sm" onClick={actions.analyzeNow}>
          <Icon name="refresh" size={14} /> Try again
        </button>
      </div>
    );
  }

  const busy = status === 'reading' || status === 'analyzing' || purifying;
  if (!busy) return null;
  const percent = (status === 'analyzing' || status === 'reading') && progress ? progress.percent : purifying ? 100 : 5;
  const message = status === 'reading' ? progress?.message || 'Reading files…' : status === 'analyzing' ? progress?.message || 'Analysing…' : 'Applying your options…';
  return (
    <div className="statusbar" role="status" aria-live="polite">
      <span className="spinner" />
      <div className="statusbar__text">
        <span>{message}</span>
      </div>
      <div className={`progress${purifying && status !== 'analyzing' ? ' progress--indeterminate' : ''}`} aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default memo(StatusBar);
