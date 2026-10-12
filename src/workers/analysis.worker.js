/**
 * Analysis worker — runs the whole purification engine off the main thread.
 *
 * Messages in:
 *   { type: 'analyze', runId, entries, evidence?, options }   parse + analyse + purify
 *                                                   (evidence: read-only third-party scripts)
 *   { type: 'purify',  runId, options }            re-purify the cached analysis (cheap)
 *
 * Messages out:
 *   { type: 'progress', runId, stage, message, percent }
 *   { type: 'analyzed', runId, report }
 *   { type: 'purified', runId, result }
 *   { type: 'error',    runId, message }
 */
import { analyzeProject, buildReport, purifyProject } from '../engine/index.js';

let cached = null; // { runId, analysis }
let purifyToken = 0;

const post = (msg) => self.postMessage(msg);

async function runPurify(runId, options) {
  const token = ++purifyToken;
  post({ type: 'progress', runId, stage: 'purify', message: 'Purifying…', percent: 100, purifying: true });
  const result = await purifyProject(cached.analysis, options);
  if (token !== purifyToken) return; // a newer request superseded this one
  post({ type: 'purified', runId, result });
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'analyze') {
      cached = null;
      const analysis = await analyzeProject(msg.entries, {
        evidence: msg.evidence,
        onProgress: (p) => post({ type: 'progress', runId: msg.runId, ...p }),
      });
      cached = { runId: msg.runId, analysis };
      post({ type: 'analyzed', runId: msg.runId, report: buildReport(analysis) });
      await runPurify(msg.runId, msg.options);
    } else if (msg.type === 'purify') {
      if (!cached || cached.runId !== msg.runId) return;
      await runPurify(msg.runId, msg.options);
    }
  } catch (err) {
    post({ type: 'error', runId: msg.runId, message: String(err?.message || err), stack: String(err?.stack || '') });
  }
};
