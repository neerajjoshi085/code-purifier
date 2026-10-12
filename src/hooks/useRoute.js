import { useEffect, useState } from 'react';

export const ROUTES = [
  { id: 'css', path: '/css', label: 'CSS Purifier' },
  { id: 'js', path: '/js', label: 'JS Purifier' },
  { id: 'docs', path: '/docs', label: 'Documentation' },
];

const NAV_EVENT = 'cp:navigate';

/** Route id for the current address. "/" (and anything unknown) is the CSS page. */
function parse() {
  if (typeof location === 'undefined') return 'css';
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const found = ROUTES.find((r) => path === r.path || path.startsWith(r.path + '/'));
  return found ? found.id : 'css';
}

/** Old links used hash routes (#/js); move them to the real path once, on load. */
function upgradeLegacyHash() {
  if (typeof location === 'undefined') return;
  const m = /^#(\/(?:css|js|docs))(?:\/.*)?$/.exec(location.hash);
  if (m) history.replaceState(history.state, '', m[1] + location.search);
}

/** Go to a route without reloading the page. */
export function navigate(path) {
  if (location.pathname !== path) history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * onClick for internal links: plain clicks navigate in place, while ctrl/cmd/shift-click and
 * middle-click keep the browser's normal behaviour (new tab or window).
 */
export function linkTo(path) {
  return (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  };
}

/** Tiny path router: /css, /js, /docs. The servers answer those paths with index.html. */
export function useRoute() {
  const [route, setRoute] = useState(() => {
    upgradeLegacyHash();
    return parse();
  });
  useEffect(() => {
    const onChange = () => {
      setRoute(parse());
      window.scrollTo({ top: 0 });
    };
    // An old #/js link opened while the app is already loaded changes only the hash.
    // Other hashes (#main, #how-it-works) are in-page anchors and are left alone.
    const onHash = () => {
      if (!/^#\/(?:css|js|docs)\b/.test(location.hash)) return;
      upgradeLegacyHash();
      onChange();
    };
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAV_EVENT, onChange);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(NAV_EVENT, onChange);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  return route;
}
