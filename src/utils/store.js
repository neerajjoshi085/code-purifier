import { useSyncExternalStore } from 'react';

/**
 * A tiny external store. Components subscribe through `useStore(selector)` and only
 * re-render when the selected slice changes (selectors must return existing references).
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (next === state) return;
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStoreSelector(store, selector) {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
