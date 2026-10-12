/**
 * Each purifier page works on ONE language. The whole project is still analysed (JavaScript
 * decides which CSS is really used), but a page only shows, changes and offers downloads for
 * its own language. HTML is always in scope because inline <style>/<script> blocks live in it.
 */

/** @typedef {'css'|'js'} Lang */

export const SCOPE = Object.freeze({
  css: { lang: 'css', label: 'CSS', noun: 'stylesheet', nouns: 'stylesheets', kinds: ['css', 'html'] },
  js: { lang: 'js', label: 'JavaScript', noun: 'script', nouns: 'scripts', kinds: ['js', 'html'] },
});

export const scopeOf = (lang) => (lang === 'js' ? SCOPE.js : SCOPE.css);

/** Purify options for a page: only its own language is modified. */
export function optionsForScope(lang) {
  return { removeUnusedCss: lang !== 'js', removeUnusedJs: lang === 'js' };
}
