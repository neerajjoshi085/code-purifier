import { memo } from 'react';
import { Icon, LogoMark } from './Icons.jsx';
import { ROUTES } from '../hooks/useHashRoute.js';
import { actions, useApp } from '../hooks/appStore.js';

// function ThemeToggle() {
//   const theme = useApp((s) => s.theme);
//   const next = theme === 'dark' ? 'light' : 'dark';
//   return (
//     <button className="btn btn--ghost btn--icon" onClick={() => actions.setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
//       <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
//     </button>
//   );
// }

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
            <a key={r.id} href={`#${r.path}`} className={`nav__link${route === r.id ? ' is-active' : ''}`} aria-current={route === r.id ? 'page' : undefined}>
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
