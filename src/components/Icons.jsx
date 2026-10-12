import { memo } from 'react';

/** Minimal stroke icon set (24×24, 1.8px stroke). */
const PATHS = {
  upload: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  code: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5',
  copy: 'M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1',
  download: 'M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5M4 19h16',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  check: 'M5 12.5 10 17.5 19 7',
  warn: 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 17.3v.2',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  chevron: 'm6 9 6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M7 4.5v15l12-7.5z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  zip: 'M6 3h9l4 4v14H6zM11 3v2h2V3m-2 4h2v2h-2m0 2h2v2h-2m0 2h2v4h-2z',
  shield: 'M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6zM8.8 12 11 14.2 15.5 9.6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  layers: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5 12 22.5l9-5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.2',
  up: 'M12 19V5m0 0-5 5m5-5 5 5',
  down: 'M12 5v14m0 0-5-5m5 5 5-5',
  refresh: 'M20 11a8 8 0 0 0-14.5-3.5M4 5v3.5h3.5M4 13a8 8 0 0 0 14.5 3.5M20 19v-3.5h-3.5',
  split: 'M4 5h7v14H4zM13 5h7v14h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  graph: 'M6 6a2 2 0 1 0 0-.01M18 6a2 2 0 1 0 0-.01M12 19a2 2 0 1 0 0-.01M7.6 7.5l3.3 9.5M16.4 7.5l-3.3 9.5',
  book: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z',
  arrow: 'M5 12h14m0 0-6-6m6 6-6 6',
};

export const Icon = memo(function Icon({ name, size = 18, className, strokeWidth = 1.8, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <path d={PATHS[name] || PATHS.file} />
    </svg>
  );
});

export const LogoMark = memo(function LogoMark({ size = 28 }) {
  return (
    // Three lines of code, the middle one struck out in red pen.
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="5" fill="var(--text)" />
      <rect x="7" y="8.5" width="18" height="3" rx="1.5" fill="var(--bg)" />
      <rect x="7" y="14.5" width="12" height="3" rx="1.5" fill="var(--bg)" opacity="0.55" />
      <rect x="7" y="20.5" width="15" height="3" rx="1.5" fill="var(--bg)" />
      <path d="M4 18.6 28 13.4" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
});
