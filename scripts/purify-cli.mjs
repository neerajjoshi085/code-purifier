#!/usr/bin/env node
/**
 * Runs the purification engine on a directory, without any browser.
 *   node scripts/purify-cli.mjs <dir> [--out <dir>] [--potential] [--minify] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject, buildReport, purifyProject } from '../src/engine/index.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: purify-cli <dir> [--out <dir>] [--potential] [--minify] [--json]');
  process.exit(1);
}
const flag = (n) => args.includes(`--${n}`);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

function walk(d, base = d, acc = []) {
  for (const name of fs.readdirSync(d)) {
    const full = path.join(d, name);
    if (fs.statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push({ path: path.relative(base, full).split(path.sep).join('/'), data: new Uint8Array(fs.readFileSync(full)) });
  }
  return acc;
}

const entries = walk(path.resolve(dir));
const analysis = await analyzeProject(entries);
const result = await purifyProject(analysis, { removePotentialCss: flag('potential'), minifyCss: flag('minify'), minifyJs: flag('minify') });
if (flag('json')) {
  console.log(JSON.stringify({ report: buildReport(analysis), stats: result.stats, findings: result.findings }, null, 2));
} else {
  const { css, js } = result.stats;
  console.log(`CSS  ${css.originalBytes} B -> ${css.purifiedBytes} B  (-${css.reduction}%)  selectors used ${css.selectors.used}/${css.selectors.total}`);
  console.log(`JS   ${js.originalBytes} B -> ${js.optimizedBytes} B  (-${js.reduction}%)  functions ${js.functionsAnalyzed}, potentially unused ${js.potentiallyUnusedFunctions}`);
  for (const f of result.findings) console.log(`${f.removed ? 'REMOVED' : 'flagged'} [${f.confidence}] ${f.file}:${f.startLine} ${f.kind} ${f.name}`);
  for (const e of analysis.errors) console.log(`${e.severity.toUpperCase()}: ${e.file ?? ''} ${e.message}`);
}
if (outDir) {
  for (const [p, r] of Object.entries(result.files)) {
    if (p.includes('#')) continue;
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, r.final);
  }
  console.log(`written to ${outDir}`);
}
