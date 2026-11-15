/**
 * browser-storage-backing.js — authority-neutral localStorage backing.
 *
 * The ONLY module in the data layer that references window.localStorage directly.
 * The structural guard (tests/no-direct-storage.test.mjs) explicitly allowlists
 * this path; every other non-wrapper module in src/ must go through the repo API.
 *
 * Returns a raw backing object suitable for injection into V1Repository:
 *   { getItem(key), setItem(key, value), removeItem(key) }
 *
 * V1Repository wraps this with createV1StorageAdapter() internally —
 * do NOT pre-create an adapter before passing this to V1Repository.
 */

export function createBrowserStorageBacking() {
  return {
    getItem:    k      => localStorage.getItem(k),
    setItem:    (k, v) => localStorage.setItem(k, v),
    removeItem: k      => localStorage.removeItem(k),
  };
}
