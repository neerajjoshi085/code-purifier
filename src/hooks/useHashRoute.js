import { useEffect, useState } from 'react';

export const ROUTES = [
  { id: 'css', path: '/css', label: 'CSS Purifier' },
  { id: 'js', path: '/js', label: 'JS Purifier' },
  { id: 'docs', path: '/docs', label: 'Documentation' },
];

function parse() {
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '') || '/css';
  const found = ROUTES.find((r) => raw === r.path || raw.startsWith(r.path + '/'));
  return found ? found.id : 'css';
}

/** Tiny hash router: #/css, #/js, #/docs — no dependency, works from any static host. */
export function useHashRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => {
      // In-page anchors such as the "Skip to content" link (#main) are not routes: stay put.
      if (location.hash && !location.hash.startsWith('#/')) return;
      setRoute(parse());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
