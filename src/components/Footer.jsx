import { memo } from 'react';
import { PRIVACY_STATEMENT } from '../utils/constants.js';
import { LogoMark } from './Icons.jsx';

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__row">
          <div className="site-footer__brand">
            <LogoMark size={22} />
            <span>Code Purifier</span>
          </div>
          <nav className="site-footer__links" aria-label="Footer">
            <a href="#/css">CSS Purifier</a>
            <a href="#/js">JS Purifier</a>
          </nav>
          <p className="site-footer__note">{PRIVACY_STATEMENT}</p>
        </div>
        <p className="site-footer__mark" aria-hidden="true">
          Code Purifier
        </p>
      </div>
    </footer>
  );
}

export default memo(Footer);
