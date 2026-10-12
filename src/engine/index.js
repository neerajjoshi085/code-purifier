/**
 * Public entry of the purification engine. Everything exported here is pure
 * JavaScript with no DOM/React dependency, so it can be tested in Node.
 */
export { analyzeProject, purifyProject, buildReport, normalizeOptions } from './pipeline.js';
export { createProject, classifyPath } from '../project/fileManager.js';
export { DEFAULT_OPTIONS, CONFIDENCE, STATUS } from '../utils/constants.js';
