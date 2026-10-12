import { memo } from 'react';
import { useApp } from '../hooks/appStore.js';
import { Icon } from './Icons.jsx';

function Toast() {
  const toast = useApp((s) => s.toast);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <Icon name={toast.kind === 'error' ? 'warn' : 'check'} size={16} /> {toast.message}
        </div>
      )}
    </div>
  );
}

export default memo(Toast);
