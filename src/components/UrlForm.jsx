import { memo, useState } from 'react';
import { actions, useApp } from '../hooks/appStore.js';
import { Icon } from './Icons.jsx';

/** How many pages of the site are read (the page-count picker was removed from the form). */
const PAGES = 5;

/** Accepts "example.com", "example.com/page" or a full URL; returns an error message or null. */
function validate(value) {
  const raw = value.trim();
  if (!raw) return 'Enter the address of the website you want to check.';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http:// and https:// addresses work.';
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return 'That doesn’t look like a full web address — try something like example.com.';
  } catch {
    return 'That doesn’t look like a valid web address.';
  }
  return null;
}

function UrlForm({ lang }) {
  const fetching = useApp((s) => s.fetching);
  const serverError = useApp((s) => s.fetchError);
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState(null);
  const error = localError || serverError;
  const hasScheme = /^[a-z][a-z0-9+.-]*:///i.test(value.trim());

  const submit = (e) => {
    e.preventDefault();
    if (fetching) return;
    const problem = validate(value);
    setLocalError(problem);
    if (!problem) actions.fetchSite(value.trim(), PAGES);
  };

  return (
    <form className="urlform" onSubmit={submit} noValidate>
      <label className="urlform__label" htmlFor="site-url">
        Which website should we check?
      </label>
      <div className={`urlbar${error ? ' has-error' : ''}${fetching ? ' is-busy' : ''}`}>
        {!hasScheme && (
          <span className="urlbar__prefix" aria-hidden="true">
            https://
          </span>
        )}
        <input
          id="site-url"
          className="urlbar__input"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="yourwebsite.com"
          value={value}
          disabled={fetching}
          aria-invalid={!!error}
          aria-describedby={error ? 'site-url-error' : 'site-url-hint'}
          onChange={(e) => {
            setValue(e.target.value);
            if (localError) setLocalError(null);
            if (serverError) actions.clearFetchError();
          }}
        />
        {fetching ? (
          <button type="button" className="urlbar__btn urlbar__btn--cancel" onClick={actions.cancelFetch}>
            <span className="spinner" /> Cancel
          </button>
        ) : (
          <button type="submit" className="urlbar__btn">
            Analyze <Icon name="arrow" size={16} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {error && (
        <p className="urlform__error" id="site-url-error" role="alert">
          <Icon name="warn" size={15} /> {error}
        </p>
      )}

      <p className="urlform__hint" id="site-url-hint">
        We read up to {PAGES} pages. {lang === 'js' ? 'JavaScript' : 'CSS'} used only on pages we don’t reach will look unused.
      </p>
    </form>
  );
}

export default memo(UrlForm);
