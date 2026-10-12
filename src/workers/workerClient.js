/**
 * Main-thread facades over the workers. Workers are created lazily so the first
 * paint never pays for the engine.
 */

let zipWorker = null;
let zipSeq = 0;
const zipPending = new Map();

function getZipWorker() {
  if (!zipWorker) {
    zipWorker = new Worker(new URL('./zip.worker.js', import.meta.url), { type: 'module' });
    zipWorker.onmessage = (e) => {
      const p = zipPending.get(e.data.id);
      if (p) {
        zipPending.delete(e.data.id);
        p.resolve(e.data);
      }
    };
    zipWorker.onerror = (e) => {
      for (const p of zipPending.values()) p.reject(new Error(e.message || 'ZIP worker failed'));
      zipPending.clear();
      zipWorker = null;
    };
  }
  return zipWorker;
}

function zipTask(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++zipSeq;
    zipPending.set(id, { resolve, reject });
    getZipWorker().postMessage({ ...message, id }, transfer);
  });
}

/** @param {ArrayBuffer} buffer @returns {Promise<{entries:{path:string,data:Uint8Array}[],warnings:string[],error:string|null}>} */
export function unzipInWorker(buffer) {
  return zipTask({ type: 'unzip', buffer }, [buffer]);
}

/** @returns {Promise<ArrayBuffer>} */
export async function zipInWorker(entries) {
  const res = await zipTask({ type: 'zip', entries });
  if (res.error) throw new Error(res.error);
  return res.buffer;
}

export function createAnalysisWorker() {
  return new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
}
