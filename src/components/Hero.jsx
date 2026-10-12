import { memo } from 'react';
import { actions } from '../hooks/appStore.js';

import kutumb from '../assets/hero/kutumb.webp';
import kusum from '../assets/hero/kusum.webp';
import trevoc from '../assets/hero/trevoc.webp';
import tessoro from '../assets/hero/tessoro.webp';
import bengaluru from '../assets/hero/bengaluru.webp';
import skyverse from '../assets/hero/skyverse.webp';

/**
 * Hero: a big centred headline over a fanned row of website cards (the top of real project
 * landing pages); each card says how much of its CSS or JavaScript the purifier would cut.
 * The percentages are illustrative.
 */
const SITES = [
  { img: kutumb, name: 'The Kutumb', css: 58, js: 27 },
  { img: kusum, name: 'Kusum · SK Fortune', css: 64, js: 33 },
  { img: trevoc, name: 'Trevoc Royal', css: 41, js: 22 },
  { img: tessoro, name: 'Aarize Tessoro', css: 69, js: 38 },
  { img: bengaluru, name: 'Kanakapura Road', css: 52, js: 29 },
  { img: skyverse, name: 'Skyverse', css: 47, js: 18 },
];

const COPY = {
  css: {
    title: ['A lighter website,', 'minus the CSS it never uses.'],
    sub: 'Enter a web address. We read every page the way a browser does and remove only the rules that provably never apply.',
    bubbles: ['@never-used', '@added-by-js'],
  },
  js: {
    title: ['A lighter website,', 'minus the code it never runs.'],
    sub: 'Enter a web address. We trace every function, import and branch, and remove only the code that provably never runs.',
    bubbles: ['@never-called', '@from-html'],
  },
};

function startWithAddress(e) {
  e.preventDefault();
  actions.setInputMode('url');
  document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // the form mounts when the mode switches; focus once it is there
  setTimeout(() => document.getElementById('site-url')?.focus({ preventScroll: true }), 350);
}

function showHowItWorks(e) {
  e.preventDefault(); // keep the #/css or #/js route in the address bar
  document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Fan({ lang, bubbles }) {
  const mid = (SITES.length - 1) / 2;
  const label = lang === 'js' ? 'JS' : 'CSS';
  return (
    <div className="fan" aria-hidden="true">
      <span className="fan__bubble fan__bubble--a">{bubbles[0]}</span>
      <span className="fan__bubble fan__bubble--b">{bubbles[1]}</span>
      <ul className="fan__row">
        {SITES.map((site, i) => (
          <li
            key={site.name}
            className="fcard"
            data-a={Math.abs(i - mid)}
            style={{ '--i': i - mid, '--a': Math.abs(i - mid), zIndex: i + 1 }}
          >
            <img className="fcard__shot" src={site.img} alt="" width="640" height="781" decoding="async" />
            <span className="fcard__bar">
              <i />
              <i />
              <i />
              <span>{site.name}</span>
            </span>
            <span className="fcard__badge">
              −{site[lang === 'js' ? 'js' : 'css']}% {label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Hero({ lang }) {
  const key = lang === 'js' ? 'js' : 'css';
  const copy = COPY[key];
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__inner">
        <h1 id="hero-title" className="hero__title">
          <span>{copy.title[0]}</span> <span>{copy.title[1]}</span>
        </h1>
        <Fan lang={key} bubbles={copy.bubbles} />
        <p className="hero__sub">{copy.sub}</p>
       
      </div>
    </section>
  );
}

export default memo(Hero);
