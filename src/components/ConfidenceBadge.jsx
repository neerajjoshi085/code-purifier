import { memo } from 'react';

const LABEL = { SAFE: 'Safe', POTENTIAL: 'Potential', UNKNOWN: 'Unknown' };
const HINT = {
  SAFE: 'Provably unused — removing it cannot change behavior.',
  POTENTIAL: 'Probably unused, but it could be reached dynamically, so it is kept.',
  UNKNOWN: 'The analyzer could not decide (unresolvable dynamic code), so it is kept.',
};

function ConfidenceBadge({ confidence, withHint = true }) {
  if (!confidence) return null;
  return (
    <span className={`badge badge--${confidence.toLowerCase()}`} title={withHint ? HINT[confidence] : undefined}>
      {LABEL[confidence]}
    </span>
  );
}

export default memo(ConfidenceBadge);
