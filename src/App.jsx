import { Component, lazy, Suspense } from 'react';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import Toast from './components/Toast.jsx';
import { useRoute } from './hooks/useRoute.js';

// Route-level code splitting: the workspace and the docs are separate chunks.
const PurifierPage = lazy(() => import('./pages/PurifierPage.jsx'));
const DocsPage = lazy(() => import('./pages/DocsPage.jsx'));

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="container fallback">
        <h2>Something went wrong</h2>
        <p className="muted">{String(this.state.error?.message || this.state.error)}</p>
        <button className="btn btn--primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

function PageFallback() {
  return (
    <div className="container fallback" role="status" aria-live="polite">
      <div className="spinner" /> <span className="muted">Loading…</span>
    </div>
  );
}

/** Keyboard "skip to content": move focus to the page body without adding #main to the address. */
function skipToMain(e) {
  const main = document.getElementById('main');
  if (!main) return;
  e.preventDefault();
  main.setAttribute('tabindex', '-1');
  main.focus();
}

export default function App() {
  const route = useRoute();
  return (
    <>
      <a className="skip-link" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <Header route={route} />
      <main id="main">
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            {route === 'docs' ? <DocsPage /> : <PurifierPage lang={route === 'js' ? 'js' : 'css'} />}
          </Suspense>
        </ErrorBoundary>
      </main>
      <Footer />
      <Toast />
    </>
  );
}
