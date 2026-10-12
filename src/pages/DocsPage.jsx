import ConfidenceBadge from '../components/ConfidenceBadge.jsx';
import { PRIVACY_STATEMENT, SAFETY_WARNING } from '../utils/constants.js';
import { Icon } from '../components/Icons.jsx';
import '../styles/docs.css';

const TOC = [
  ['how', 'How it works'],
  ['confidence', 'Confidence levels'],
  ['css', 'How CSS usage is decided'],
  ['js', 'How JavaScript is analysed'],
  ['review', 'Choosing what to remove'],
  ['inputs', 'Supported input'],
  ['preview', 'Compare & download'],
  ['privacy', 'Privacy'],
  ['limits', 'Limitations'],
];

export default function DocsPage() {
  return (
    <div className="container docs">
      <header className="docs__hero">
        <span className="eyebrow">Documentation</span>
        <h1>Purify with confidence</h1>
        <p>
          Code Purifier removes unused CSS and dead JavaScript from your site. It uses real parsers and scope analysis rather than text matching, tells you <em>how sure</em> it is about every removal,
          and never deletes code it is unsure about unless you say so.
        </p>
      </header>

      <div className="docs__layout">
        <nav className="docs__toc" aria-label="On this page">
          <span className="eyebrow">On this page</span>
          <ul>
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="docs__body">
          <section id="how">
            <h2>How it works</h2>
            <p>
              The <strong>CSS Purifier</strong> and <strong>JS Purifier</strong> pages each show and change only their own language. Both still read your whole project, because JavaScript decides which CSS is really used
              (and the HTML decides which JavaScript is called) — but the CSS page never touches your scripts, and the JS page never touches your stylesheets.
            </p>
            <ol className="steps">
              <li>
                <strong>Parse.</strong> HTML is parsed with a streaming HTML parser, CSS with a tolerant CSS parser (<code>@media</code>, <code>@supports</code>, <code>@container</code>, <code>@layer</code>, nesting, keyframes, font-face, custom properties) and JavaScript into an AST (modules, JSX, classes, async code).
                A broken file never stops the others.
              </li>
              <li>
                <strong>Collect evidence.</strong> Every element, class, id, tag and attribute in your HTML — plus everything JavaScript can add: <code>classList.add('x')</code>, <code>className = …</code>,
                <code>querySelector('.menu')</code>, <code>getElementById</code>, <code>setAttribute</code>, <code>dataset</code>, <code>innerHTML</code> templates, JSX <code>className</code>, and class names built from constants,
                ternaries, template literals or function arguments.
              </li>
              <li>
                <strong>Judge.</strong> Each CSS selector and each JavaScript declaration is classified as <em>Used</em>, <em>Potentially unused</em> or <em>Safe to remove</em>, with a confidence level.
              </li>
              <li>
                <strong>Edit the source, don't regenerate it.</strong> Removals are cut out of your original text, so formatting, comments, hacks, source order, <code>@media</code> blocks and execution order are preserved. The result is re-parsed as a safety check.
              </li>
            </ol>
          </section>

          <section id="confidence">
            <h2>Confidence levels</h2>
            <p>Every removal candidate carries one of three levels. By default only <strong>Safe</strong> items are removed.</p>
            <div className="docs__cards">
              <div className="docs__card">
                <ConfidenceBadge confidence="SAFE" withHint={false} />
                <p>Provably unused. A required class, id or tag appears nowhere in HTML or JavaScript; a local JavaScript function has no references, no export and no side effects.</p>
              </div>
              <div className="docs__card">
                <ConfidenceBadge confidence="POTENTIAL" withHint={false} />
                <p>Probably unused but reachable in ways static analysis cannot rule out: global functions of classic scripts, exports nobody imports, classes matching a dynamic pattern such as <code>'btn-' + type</code>, selectors whose parts exist but never together.</p>
              </div>
              <div className="docs__card">
                <ConfidenceBadge confidence="UNKNOWN" withHint={false} />
                <p>The analyzer could not decide: <code>eval()</code>, <code>with</code>, <code>innerHTML</code> filled from the network, or class names written from values it cannot resolve. Kept unless you override.</p>
              </div>
            </div>
            <p className="callout callout--warn">
              <Icon name="warn" size={16} /> {SAFETY_WARNING}
            </p>
            <h3>Statuses</h3>
            <table className="docs__table">
              <thead>
                <tr><th>Status</th><th>Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td>Used</td><td>Referenced by live code, HTML or a dynamic evidence source.</td></tr>
                <tr><td>Potentially unused</td><td>No reference found, but removal is not provably safe (confidence Potential or Unknown).</td></tr>
                <tr><td>Safe to remove</td><td>No reference found and removal cannot change behavior (confidence Safe).</td></tr>
              </tbody>
            </table>
          </section>

          <section id="css">
            <h2>How CSS usage is decided</h2>
            <ul>
              <li><strong>Compound matching.</strong> <code>button.primary[disabled]:hover</code> is checked as one compound against an index of every element, so <code>.a.b</code> is only “used” if some element can be both. State pseudo-classes (<code>:hover</code>, <code>:focus</code>…) and pseudo-elements never make a selector unused.</li>
              <li><strong>Combinators</strong> (<code>&gt;</code>, space, <code>+</code>, <code>~</code>) are evaluated per compound, not structurally: JavaScript can re-parent nodes, so ancestry in the static HTML is not trustworthy.</li>
              <li><strong>Logical pseudo-classes</strong> <code>:is()</code>, <code>:where()</code>, <code>:has()</code> are evaluated; <code>:not()</code> is assumed satisfiable.</li>
              <li><strong>Grouped selectors</strong> are pruned individually: <code>.a, .gone</code> becomes <code>.a</code>.</li>
              <li><strong>At-rules.</strong> Empty <code>@media</code>/<code>@supports</code>/<code>@container</code> blocks disappear. An emptied <code>@layer</code> block that first declared a layer becomes a bare <code>@layer name;</code> so cascade order never changes.</li>
              <li><strong>@keyframes / @font-face</strong> are kept only while a surviving rule references them (including via variables and from other stylesheets). A variable used only by a removed rule is unused too.</li>
              <li><strong>Custom properties</strong> can be read from JavaScript or other pages, so unreferenced ones are always <em>Potential</em>, never Safe.</li>
              <li><strong>Dynamic classes.</strong> <code>'btn-' + type</code> creates a pattern <code>btn-*</code>: matching classes are kept as Potential. Writes with <em>no</em> known part (<code>el.className = value</code>) in your own scripts turn every other unmatched class into <em>Unknown</em>. The same kind of write inside a well-known library (jQuery, Bootstrap, plugins) does not, because a library only passes on the class names your own code gives it.</li>
              <li><strong>Third-party widgets.</strong> Scripts a website loads from well-known public CDNs (cdnjs, jsDelivr, unpkg…) are read to see which classes they add; they are never changed. Classes added by scripts the purifier cannot see (other hosts, or a CDN script missing from an upload) are not known to it, so test the purified site before you publish it.</li>
            </ul>
          </section>

          <section id="js">
            <h2>How JavaScript is analysed</h2>
            <ul>
              <li><strong>Scope-aware.</strong> Real scope analysis resolves every identifier: shadowing, hoisting, destructuring, closures, classes, JSX component names, namespace imports (<code>ns.fn</code>).</li>
              <li><strong>Liveness, not counting.</strong> Code reachable only from other dead code is dead too: helpers used only by removed functions go with them; mutual recursion doesn't keep itself alive.</li>
              <li><strong>Safe removals:</strong> unused imports (the module's side effects are kept with <code>import './x.js'</code>), unused local functions/classes/variables with side-effect-free initialisers, code after <code>return/throw</code>, and branches of constant conditions such as <code>if (false)</code>.</li>
              <li><strong>Never removed automatically (Potential):</strong> global functions and variables of classic scripts (HTML <code>onclick</code>, other scripts, <code>window.x</code> and string lookups may use them), exports not imported inside the project, and declarations whose initialiser may have side effects (<code>const x = track()</code>).</li>
              <li><strong>Referenced from HTML.</strong> Inline handlers (<code>onclick="save()"</code>), <code>javascript:</code> URLs, <code>window.fn</code> / <code>globalThis.fn</code>, <code>setTimeout('fn()')</code> and attribute values naming a function all mark it as used.</li>
              <li><strong>Modules.</strong> Imports, exports, re-exports, <code>export *</code>, dynamic <code>import()</code> and import maps are resolved across files; a dynamically imported module keeps all its exports.</li>
              <li><strong>Hazards.</strong> <code>eval()</code> or <code>with</code> in scope makes every enclosing declaration <em>Unknown</em>.</li>
            </ul>
          </section>

          <section id="review">
            <h2>Choosing what to remove</h2>
            <table className="docs__table">
              <thead>
                <tr><th>Finding</th><th>By default</th></tr>
              </thead>
              <tbody>
                <tr><td>Safe</td><td>Removed — unused CSS selectors, rules, keyframes and fonts, and unused JavaScript that cannot change behavior.</td></tr>
                <tr><td>Potential / Unknown</td><td>Kept, because they may still be used.</td></tr>
              </tbody>
            </table>
          </section>

          <section id="inputs">
            <h2>Supported input</h2>
            <ul>
              <li><strong>A website address.</strong> Type <code>example.com</code> and the page is downloaded with its stylesheets, scripts, images and fonts. Choose how many pages to scan: the tool follows same-site links breadth-first, because a class only needed on a page you skipped will look unused. Scripts from well-known public CDNs are read for evidence only; other files hosted on other domains (tag managers, widgets) can’t be downloaded and are listed as skipped. Pages must be public — sites behind a login, and addresses on private networks, can’t be fetched.</li>
              <li><code>.html</code>, <code>.css</code>, <code>.js</code>, <code>.mjs</code>, <code>.jsx</code> — drag several at once, or pick a folder.</li>
              <li><code>.zip</code> of a whole website: extracted in your browser; dependencies (<code>&lt;link&gt;</code>, <code>&lt;script&gt;</code>, <code>@import</code>, <code>import</code>) are mapped and the whole project is analysed together. Images and fonts are kept untouched in the optimized download.</li>
              <li><em>Paste Code</em> for quick experiments: separate HTML, CSS and JS tabs; analysis re-runs when you stop typing.</li>
              <li>Inline <code>&lt;style&gt;</code> and <code>&lt;script&gt;</code> blocks are purified too and written back into the HTML.</li>
            </ul>
          </section>

          <section id="preview">
            <h2>Compare &amp; download</h2>
            <ul>
              <li><strong>Compare</strong> shows original and purified code side by side with syntax highlighting, line numbers, search, copy and download. Removed lines are highlighted by confidence; the panes stay aligned while scrolling.</li>
              <li><strong>Download</strong> CSS, JavaScript, HTML, a ZIP of the purified code, or <em>Optimized Website</em>: the full project with the original folder structure.</li>
            </ul>
          </section>

          <section id="privacy">
            <h2>Privacy</h2>
            <p className="callout">
              <Icon name="shield" size={16} /> {PRIVACY_STATEMENT}
            </p>
            <p>
              Analysis runs in Web Workers inside this page. The only thing the server does is download a website’s public files when you enter its address; it doesn’t store them or log their contents, and files you upload or paste are never sent anywhere. There is no analytics and no external font or script requests.
            </p>
          </section>

          <section id="limits">
            <h2>Limitations</h2>
            <ul>
              <li>Static analysis cannot see code that is generated from data fetched at runtime, minified third-party widgets that add classes, or frameworks that bind classes by convention. Those items are kept as <em>Potential</em> or <em>Unknown</em>; still, test the purified site before you publish it.</li>
              <li>Selectors are matched against all provided pages together. A class used on any page keeps its rule.</li>
              <li>TypeScript, SCSS and Vue/Svelte single-file components are not parsed — upload the compiled output.</li>
            </ul>
          </section>
        </article>
      </div>
    </div>
  );
}
