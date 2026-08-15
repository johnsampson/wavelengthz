export function shouldSearch(query) {
  return query.trim().length >= 3;
}

export function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// Deck mode (Music/People) persistence -- index.html used to hardcode
// `mode: 'people'` as the initial value on every fresh page load, so
// switching to Music mode never stuck: navigating away and back (even just
// tapping an artist result and hitting the browser's back button) always
// landed back on People, regardless of which mode the links/toggle were
// actually pointed at. `storage` is passed in explicitly (localStorage in
// the real page) rather than read as a global, so this stays testable
// without stubbing `window` -- same reasoning as swipe.js's
// attachSwipeDeck taking its container as a parameter instead of querying
// the DOM itself.
const DECK_MODE_KEY = 'wl_deck_mode';

export function loadStoredMode(storage) {
  const value = storage.getItem(DECK_MODE_KEY);
  return value === 'music' ? 'music' : 'people'; // 'people' is the only other valid value, and the safe default for anything else (unset, corrupted)
}

export function storeMode(storage, mode) {
  storage.setItem(DECK_MODE_KEY, mode);
}

// Search-state handoff across the full-page navigation to /artist?id=... --
// selecting a search result there is a real navigation (not an SPA route),
// so the deck's own Alpine component (and its in-memory searchQuery/
// searchResults) is fully torn down and rebuilt from scratch on return,
// same as a mode default with nowhere to persist to. Saved right before
// navigating away (selectArtist, index.html), consumed at most once on the
// way back (takeSearchState removes it immediately on read) so a search
// only reopens automatically for the one return trip it belongs to --
// not on every unrelated later visit to the deck within the same browser
// session. sessionStorage (not localStorage) deliberately: this is a
// mid-task handoff, not a lasting preference like the mode above.
const DECK_SEARCH_KEY = 'wl_deck_search';

export function saveSearchState(storage, { query, results }) {
  storage.setItem(DECK_SEARCH_KEY, JSON.stringify({ query, results }));
}

export function takeSearchState(storage) {
  const raw = storage.getItem(DECK_SEARCH_KEY);
  if (raw == null) return null;
  storage.removeItem(DECK_SEARCH_KEY);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.query !== 'string' || !Array.isArray(parsed?.results)) return null;
    return parsed;
  } catch {
    return null; // corrupted entry -- treat the same as nothing saved, don't throw
  }
}
