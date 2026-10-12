import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiHandler } from './server/api.js';

// The site-fetch endpoint (browsers can't read other sites' files) runs inside the dev and
// preview servers; `npm start` serves it next to the built app (server/prod.mjs).
function siteFetcherApi() {
  const handle = createApiHandler();
  const mount = (server) => {
    server.middlewares.use((req, res, next) => {
      handle(req, res).then((handled) => handled || next(), next);
    });
  };
  return { name: 'code-purifier:site-fetcher', configureServer: mount, configurePreviewServer: mount };
}

// The analysis engine lives entirely inside Web Workers (src/workers) and is
// code-split from the UI bundle, so the first paint only ships React + the shell.
export default defineConfig({
  plugins: [react(), siteFetcherApi()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
