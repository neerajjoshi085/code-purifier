/**
 * Shared vocabulary for the whole engine + UI.
 * Keep this file dependency-free: it is imported by workers and React alike.
 */

/** How sure the engine is that a removal is behaviour-preserving. */
export const CONFIDENCE = Object.freeze({
  SAFE: 'SAFE',
  POTENTIAL: 'POTENTIAL',
  UNKNOWN: 'UNKNOWN',
});

/** Classification of a piece of code. */
export const STATUS = Object.freeze({
  USED: 'USED',
  POTENTIALLY_UNUSED: 'POTENTIALLY_UNUSED',
  SAFE_TO_REMOVE: 'SAFE_TO_REMOVE',
});

export const STATUS_LABEL = Object.freeze({
  USED: 'Used',
  POTENTIALLY_UNUSED: 'Potentially unused',
  SAFE_TO_REMOVE: 'Safe to remove',
});

/** Lowest rank = most certain. */
export const CONFIDENCE_RANK = Object.freeze({ SAFE: 0, POTENTIAL: 1, UNKNOWN: 2 });

export function weakestConfidence(a, b) {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

export function statusForConfidence(confidence) {
  return confidence === CONFIDENCE.SAFE ? STATUS.SAFE_TO_REMOVE : STATUS.POTENTIALLY_UNUSED;
}

export const FILE_KIND = Object.freeze({
  HTML: 'html',
  CSS: 'css',
  JS: 'js',
  ASSET: 'asset',
});

export const HTML_EXT = ['.html', '.htm'];
export const CSS_EXT = ['.css'];
export const JS_EXT = ['.js', '.mjs', '.jsx', '.cjs'];
export const ZIP_EXT = ['.zip'];

/** Extensions accepted by the uploader (direct uploads). ZIP contents may include anything. */
export const ACCEPTED_EXT = [...HTML_EXT, ...CSS_EXT, '.js', '.mjs', '.jsx', ...ZIP_EXT];

/** Output limits that keep the browser responsive. */
export const LIMITS = Object.freeze({
  maxZipEntries: 20000,
  maxZipBytes: 600 * 1024 * 1024,
  maxTextFileBytes: 40 * 1024 * 1024,
  maxFindingsInReport: 20000,
});

export const SKIPPED_PATH_PARTS = ['__MACOSX/', 'node_modules/', '.git/', '.svn/'];
export const SKIPPED_FILE_NAMES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

/**
 * Default options: ONLY safe optimisations are on.
 */
export const DEFAULT_OPTIONS = Object.freeze({
  removeUnusedCss: true,
  removePotentialCss: false,
  removeUnusedJs: true,
  minifyCss: false,
  minifyJs: false,
  /** CSS selectors/classes/ids to always keep. One entry per item; /regex/ allowed. */
  safelist: [],
  /** Per-finding user overrides: { [findingId]: 'remove' | 'keep' } */
  overrides: {},
});

export const SAFETY_WARNING =
  'Dynamic JavaScript references may not be detectable. Test the optimized code before you publish it.';

/** The "test before publishing" reminder, worded for each page's language. */
export const SAFETY_WARNINGS = Object.freeze({
  css: 'Classes added by JavaScript at runtime may not be detectable. Test the purified site before you publish it.',
  js: SAFETY_WARNING,
});

export const PRIVACY_STATEMENT =
  'Analysis runs in your browser. If you enter a website address, our server only downloads that site’s public files for you and keeps nothing. Files you upload or paste never leave your device.';

export const UPLOAD_PRIVACY = 'Uploaded and pasted code is read and analysed on your device. It is never sent to a server.';
