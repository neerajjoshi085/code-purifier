/**
 * Application state + actions. UI components never contain purification logic:
 * they read state with `useApp(selector)` and call `actions.*`; all heavy work
 * happens in the analysis worker.
 */
import { DEFAULT_OPTIONS } from '../utils/constants.js';
import { createStore, useStoreSelector } from '../utils/store.js';
import { debounce } from '../utils/debounce.js';
import { createAnalysisWorker } from '../workers/workerClient.js';
import { itemsFromFileList, readItems } from '../project/fileReader.js';
import { fetchSiteFiles } from '../project/siteClient.js';
import { optionsForScope } from '../utils/scope.js';

function storedTheme() {
  try {
    const t = localStorage.getItem('cp-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage unavailable */
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const store = createStore({
  theme: storedTheme(),
  inputMode: 'url', // 'url' | 'upload' | 'paste'
  files: [], // LoadedFile[] (url and upload modes)
  site: null, // { url, host, origin, pages, bytes } when `files` came from a website address
  fetching: false, // a website is being downloaded
  fetchError: null,
  pasted: { html: '', css: '', js: '' },
  options: { ...DEFAULT_OPTIONS },
  status: 'idle', // idle | reading | analyzing | ready | error
  purifying: false,
  progress: null,
  runId: 0,
  report: null,
  result: null,
  project: [], // snapshot of the files the current report/result belong to
  issues: [], // problems while reading files (unsupported, broken ZIP…)
  engineError: null,
  view: { tab: 'compare', lang: 'css', file: null, focusLine: null, focusFinding: null },
  toast: null,
});

export function useApp(selector) {
  return useStoreSelector(store, selector);
}

let worker = null;
let toastTimer = null;
let fetchController = null; // AbortController of the website download in flight
let pendingProject = null; // project snapshot of the analysis in flight
let sentOptions = null; // options object the worker last received (to detect changes made meanwhile)

/* ------------------------------------------------------------------ helpers */

function currentEntries() {
  const s = store.getState();
  if (s.inputMode === 'paste') {
    const out = [];
    if (s.pasted.html.trim()) out.push({ path: 'index.html', text: s.pasted.html });
    if (s.pasted.css.trim()) out.push({ path: 'style.css', text: s.pasted.css });
    if (s.pasted.js.trim()) out.push({ path: 'script.js', text: s.pasted.js });
    return out;
  }
  return s.files.map((f) => (f.kind === 'asset' ? { path: f.path, size: f.size } : { path: f.path, text: f.text }));
}

/** Files of the current project in the shape the download manager expects. */
export function getProjectFiles() {
  const s = store.getState();
  if (s.inputMode === 'paste') {
    return [
      s.pasted.html.trim() && { path: 'index.html', kind: 'html', text: s.pasted.html },
      s.pasted.css.trim() && { path: 'style.css', kind: 'css', text: s.pasted.css },
      s.pasted.js.trim() && { path: 'script.js', kind: 'js', text: s.pasted.js },
    ].filter(Boolean);
  }
  return s.files;
}

function killWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function handleWorkerMessage(e) {
  const msg = e.data;
  if (msg.runId !== store.getState().runId) return; // stale run
  switch (msg.type) {
    case 'progress':
      store.setState({ progress: { stage: msg.stage, message: msg.message, percent: msg.percent }, ...(msg.purifying ? { purifying: true } : {}) });
      break;
    case 'analyzed':
      store.setState({ report: msg.report, project: pendingProject || [], status: 'ready', purifying: true });
      break;
    case 'purified':
      store.setState({ result: msg.result, purifying: false, status: 'ready', progress: null });
      // Options may have changed while the worker was busy: catch up.
      if (store.getState().options !== sentOptions) schedulePurify();
      break;
    case 'error':
      store.setState({ status: 'error', engineError: msg.message, purifying: false, progress: null });
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ analysis scheduling */

function startAnalysis() {
  const entries = currentEntries();
  const s = store.getState();
  if (!entries.length) {
    killWorker();
    store.setState({ status: 'idle', report: null, result: null, project: [], progress: null, purifying: false, engineError: null });
    return;
  }
  killWorker();
  worker = createAnalysisWorker();
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (ev) => {
    store.setState({ status: 'error', engineError: ev.message || 'The analysis worker crashed.', purifying: false });
  };
  const runId = s.runId + 1;
  store.setState({
    runId,
    status: 'analyzing',
    purifying: false,
    progress: { stage: 'read', message: 'Starting…', percent: 1 },
    engineError: null,
    // keep the previous report/result on screen until the new one arrives (no flicker while typing)
  });
  pendingProject = getProjectFiles().map((f) => ({ ...f }));
  sentOptions = store.getState().options;
  // Scripts a fetched website loads from public CDNs: read for evidence only, never purified.
  const evidence = s.inputMode !== 'paste' && s.site?.evidence ? s.site.evidence : [];
  worker.postMessage({ type: 'analyze', runId, entries, evidence, options: sentOptions });
}

const scheduleAnalysisFast = debounce(startAnalysis, 150);
const scheduleAnalysisTyping = debounce(startAnalysis, 700); // paste mode: don't re-analyse on every keystroke

function startPurify() {
  const s = store.getState();
  if (!worker || !s.report) return;
  store.setState({ purifying: true });
  sentOptions = s.options;
  worker.postMessage({ type: 'purify', runId: s.runId, options: sentOptions });
}
const schedulePurify = debounce(startPurify, 220);

/* ------------------------------------------------------------------ actions */

export const actions = {
  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('cp-theme', theme);
    } catch {
      /* ignore */
    }
    store.setState({ theme });
  },

  /**
   * The CSS and JS pages each modify only their own language. Analysis still covers everything
   * (JavaScript decides which CSS is used), so switching pages just re-purifies the cached analysis.
   */
  setScope(lang) {
    const patch = optionsForScope(lang);
    const current = store.getState().options;
    if (current.removeUnusedCss === patch.removeUnusedCss && current.removeUnusedJs === patch.removeUnusedJs) return;
    store.setState({ options: { ...current, ...patch } });
    schedulePurify();
  },

  setInputMode(mode) {
    const wasPaste = store.getState().inputMode === 'paste';
    store.setState({ inputMode: mode });
    // URL and upload share the same files; only switching to/from pasted code changes the project.
    if (wasPaste !== (mode === 'paste')) scheduleAnalysisFast();
  },

  /** Downloads a website (through the server) and analyses it, replacing the current project. */
  async fetchSite(url, maxPages = 5) {
    fetchController?.abort();
    const controller = (fetchController = new AbortController());
    store.setState({ fetching: true, fetchError: null, status: 'reading', progress: { stage: 'read', message: 'Contacting the website…', percent: 3 } });
    try {
      const { site, files, issues } = await fetchSiteFiles(url, {
        maxPages,
        signal: controller.signal,
        onProgress: (p) => controller === fetchController && store.setState({ progress: { stage: 'read', message: p.message, percent: p.percent } }),
      });
      if (controller !== fetchController) return;
      store.setState((s) => ({ files, site, issues, inputMode: 'url', fetching: false, options: { ...s.options, overrides: {} } }));
      scheduleAnalysisFast.cancel();
      startAnalysis();
    } catch (err) {
      if (controller !== fetchController) return;
      store.setState({ fetching: false, fetchError: err?.name === 'AbortError' ? null : err?.message || 'Something went wrong while fetching that site.', status: store.getState().report ? 'ready' : 'idle', progress: null });
    } finally {
      if (controller === fetchController) fetchController = null;
    }
  },

  cancelFetch() {
    fetchController?.abort();
  },

  clearFetchError() {
    store.setState({ fetchError: null });
  },

  async addItems(items) {
    store.setState({ status: 'reading', progress: { stage: 'read', message: 'Reading files…', percent: 1 } });
    const { files, issues } = await readItems(items);
    const prev = store.getState();
    const map = new Map(prev.files.map((f) => [f.path, f]));
    for (const f of files) map.set(f.path, f);
    store.setState({
      files: [...map.values()].sort((a, b) => a.path.localeCompare(b.path)),
      site: null,
      issues,
      inputMode: 'upload',
      status: prev.report ? 'ready' : 'idle',
    });
    scheduleAnalysisFast();
  },

  addFileList(fileList) {
    return actions.addItems(itemsFromFileList(fileList));
  },

  removeFile(path) {
    store.setState((s) => ({ files: s.files.filter((f) => f.path !== path) }));
    scheduleAnalysisFast();
  },

  clearProject() {
    scheduleAnalysisFast.cancel();
    scheduleAnalysisTyping.cancel();
    schedulePurify.cancel();
    fetchController?.abort();
    killWorker();
    store.setState({
      files: [],
      site: null,
      fetching: false,
      fetchError: null,
      pasted: { html: '', css: '', js: '' },
      status: 'idle',
      report: null,
      result: null,
      project: [],
      issues: [],
      engineError: null,
      progress: null,
      purifying: false,
      options: { ...store.getState().options, overrides: {} },
      view: { tab: 'compare', lang: store.getState().view.lang, file: null, focusLine: null, focusFinding: null },
    });
  },

  setPasted(lang, value) {
    store.setState((s) => ({ pasted: { ...s.pasted, [lang]: value } }));
    scheduleAnalysisTyping();
  },

  analyzeNow() {
    scheduleAnalysisFast.cancel();
    scheduleAnalysisTyping.cancel();
    startAnalysis();
  },

  /** Merge an options patch; re-purifies (debounced) using the cached analysis. */
  setOptions(patch) {
    store.setState((s) => ({ options: { ...s.options, ...patch } }));
    schedulePurify();
  },

  setOverride(id, value) {
    store.setState((s) => {
      const overrides = { ...s.options.overrides };
      if (value) overrides[id] = value;
      else delete overrides[id];
      return { options: { ...s.options, overrides } };
    });
    schedulePurify();
  },

  clearOverrides() {
    store.setState((s) => ({ options: { ...s.options, overrides: {} } }));
    schedulePurify();
  },

  setView(patch) {
    store.setState((s) => ({ view: { ...s.view, ...patch } }));
  },

  /** Jump to a finding in the comparison view. */
  focusFinding(finding) {
    const result = store.getState().result;
    const fileKey = result && Object.values(result.files).find((f) => f.displayPath === finding.file)?.path;
    store.setState((s) => ({
      view: { ...s.view, tab: 'compare', lang: finding.lang, file: fileKey || s.view.file, focusLine: finding.startLine, focusFinding: finding.id },
    }));
  },

  dismissIssues() {
    store.setState({ issues: [] });
  },

  toast(message, kind = 'info') {
    clearTimeout(toastTimer);
    store.setState({ toast: { message, kind, id: Date.now() } });
    toastTimer = setTimeout(() => store.setState({ toast: null }), 3200);
  },
};
