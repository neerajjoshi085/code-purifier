import { memo } from 'react';
import { Icon, LogoMark } from './Icons.jsx';
import { ROUTES } from '../hooks/useHashRoute.js';
import { actions, useApp } from '../hooks/appStore.js';



function Header({ route }) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="brand" href="#/css" aria-label="Code Purifier home">
          <LogoMark />
          <span className="brand__name">Code Purifier</span>
        </a>
        <nav className="nav" aria-label="Primary">
          {/* The documentation now lives in short under the form; its page stays reachable at #/docs. */}
          {ROUTES.filter((r) => r.id !== 'docs').map((r) => (
            <a key={r.id} href={`${r.path}`} className={`nav__link${route === r.id ? ' is-active' : ''}`} aria-current={route === r.id ? 'page' : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        {/* <ThemeToggle /> */}
      </div>
    </header>
  );
}

export default memo(Header);
