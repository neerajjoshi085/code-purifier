import { Component, lazy, Suspense } from 'react';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import Toast from './components/Toast.jsx';
import { useHashRoute } from './hooks/useHashRoute.js';

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

export default function App() {
  const route = useHashRoute();
  return (
    <>
      <a className="skip-link" href="#main">
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
