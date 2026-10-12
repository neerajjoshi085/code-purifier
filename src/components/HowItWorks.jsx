import { memo } from 'react';

/** The short documentation shown under the form: how it works, what is removed, what to watch. */
const COPY = {
  css: {
    lede: 'Most sites ship CSS for pages, plugins and themes they stopped using long ago. The purifier finds it the way a browser would, and removes only what it can prove is dead.',
    steps: [
      ['Enter a website', 'We download the pages you choose, with their stylesheets and scripts. Nothing is stored.'],
      ['We read it like a browser', 'Every selector is matched against the HTML and the classes your scripts add, including libraries loaded from public CDNs.'],
      ['Only safe cuts', 'Rules that provably never apply go, with unused @keyframes and @font-face. Anything uncertain stays.'],
      ['Compare and download', 'Check the side-by-side view, then download the purified CSS or the whole website.'],
    ],
    sampleTitle: 'What happens to each rule',
    sample: [
      ['used', '.card { border-radius: 12px; }', 'Used', 'kept'],
      ['safe', '.btn-secondary { background: #f3d9c9; }', 'Safe', 'removed'],
      ['potential', '.modal.show { display: block; }', 'Potential', 'kept, a script may add it'],
      ['unknown', '.theme-dark .nav { color: #fff; }', 'Unknown', 'kept, can’t be decided'],
    ],
    tips: [
      'Scan more pages: a class used only on a page you skip looks unused.',
      'Classes added by scripts on other websites, like widgets and tag managers, are invisible to the purifier.',
      'Test the purified site before you publish it.',
    ],
  },
  js: {
    lede: 'Old features, unused imports and dead branches pile up in every script. The purifier traces what actually runs, and removes only what it can prove never does.',
    steps: [
      ['Enter a website', 'We download the pages you choose, with their scripts and stylesheets. Nothing is stored.'],
      ['We trace every call', 'Functions, imports and branches are followed across files, inline scripts and HTML event handlers.'],
      ['Only safe cuts', 'Code that provably never runs goes. Anything reachable from HTML, globals or dynamic code stays.'],
      ['Compare and download', 'Check the side-by-side view, then download the optimized scripts or the whole website.'],
    ],
    sampleTitle: 'What happens to each piece of code',
    sample: [
      ['used', 'function openModal(id) { … }', 'Used', 'kept'],
      ['safe', "import { debounce } from './utils.js';", 'Safe', 'removed'],
      ['potential', 'function onSave() { … }', 'Potential', 'kept, the HTML may call it'],
      ['unknown', 'function plugin() { eval(src); }', 'Unknown', 'kept, can’t be traced'],
    ],
    tips: [
      'Functions in classic scripts may be called from other pages or the console, so they are only flagged.',
      'Code run through eval() or built from strings cannot be traced and is kept.',
      'Test the optimized site before you publish it.',
    ],
  },
};

function HowItWorks({ lang }) {
  const c = COPY[lang === 'js' ? 'js' : 'css'];
  return (
    <section id="how-it-works" className="howto container" aria-labelledby="howto-title">
      <div className="howto__top">
        <h2 id="howto-title" className="howto__title">
          How it works
        </h2>
        <p className="howto__lede">{c.lede}</p>
      </div>

      <ol className="howto__steps">
        {c.steps.map(([title, text], i) => (
          <li key={title} className="howto__step">
            <span className="howto__no" aria-hidden="true">
              {i + 1}
            </span>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ol>

      <div className="howto__bottom">
        <figure className="sample">
          <figcaption className="sample__title">{c.sampleTitle}</figcaption>
          <ol className="sample__lines">
            {c.sample.map(([tone, code, level, fate]) => (
              <li key={tone} className={`sample__line sample__line--${tone}`}>
                <code>{code}</code>
                <span className="sample__fate">
                  <b>{level}</b> · {fate}
                </span>
              </li>
            ))}
          </ol>
        </figure>
        <div className="howto__tips">
          <h3>Good to know</h3>
          <ul>
            {c.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default memo(HowItWorks);
