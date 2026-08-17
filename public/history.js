import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';

// Extracted from history.html's inline script so the pagination logic below
// is directly testable (same pattern as settings.js). The page just does
// `window.historyApp = createHistoryApp`.
export const PAGE_SIZE = 20;

// Guarded rather than stubbed in every pagination test: this file runs both
// as a real browser module (where window always exists) and under this
// project's Workers-runtime test environment (test/public/*.ts), which has
// no window at all unless a test explicitly stubs one (see settings.test.ts).
function scrollToTop() {
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Persists which tab (People/Artists/Tracks) was last selected, same fix
// and reasoning as search.js's deck-mode persistence -- this page used to
// hardcode `mode: 'people'` on every fresh load, so a link back into
// History (e.g. from an artist's own history entry) always dropped back to
// the People tab regardless of which one the user actually had open.
const HISTORY_MODE_KEY = 'wl_history_mode';

// What each tab is counting, so the total reads as "143 artists" rather than
// a bare number. Keyed by the same mode values setMode stores.
const HISTORY_NOUNS = {
  people: { singular: 'person', plural: 'people' },
  artist: { singular: 'artist', plural: 'artists' },
  track: { singular: 'song', plural: 'songs' },
};
const VALID_MODES = ['people', 'artist', 'track'];
// No localStorage in this project's Workers-runtime test environment
// unless a test explicitly stubs one -- same guard shape as scrollToTop
// above, but as a real fallback object (not a skipped call) since `mode`
// needs an actual value either way.
const noopStorage = { getItem: () => null, setItem: () => {} };

export function loadStoredHistoryMode(storage) {
  const value = storage.getItem(HISTORY_MODE_KEY);
  return VALID_MODES.includes(value) ? value : 'people';
}

export function createHistoryApp(storage = typeof localStorage !== 'undefined' ? localStorage : noopStorage) {
  return {
    mode: loadStoredHistoryMode(storage),
    swipes: [],
    error: null,
    offset: 0,
    hasNext: false,
    // Count of everything matching the current tab + direction filter, not
    // just the page on screen (issue #2). null while unknown, so the header
    // shows nothing rather than a misleading 0 before the first load.
    total: null,
    directionFilter: null, // null = all, otherwise 'left' | 'right'
    get hasPrev() {
      return this.offset > 0;
    },

    /** e.g. "143 artists" -- empty while unknown so nothing flashes. */
    get totalLabel() {
      if (this.total == null) return '';
      const noun = this.directionFilter === 'blocked' ? 'blocked' : HISTORY_NOUNS[this.mode] ?? 'items';
      if (this.directionFilter === 'blocked') return `${this.total} blocked`;
      return `${this.total} ${this.total === 1 ? noun.singular : noun.plural}`;
    },

    async init() {
      if (!(await requireAuth())) return;
      await this.load();
    },

    async setMode(mode) {
      this.mode = mode;
      storage.setItem(HISTORY_MODE_KEY, mode);
      this.offset = 0;
      // "Blocked" is a people-only concept -- switching to an Artists/Tracks
      // tab with it still selected would silently try (and fail) to load
      // blocked-users data for a music mode.
      if (mode !== 'people' && this.directionFilter === 'blocked') this.directionFilter = null;
      await this.load({ isReload: true });
    },

    async setDirectionFilter(direction) {
      this.directionFilter = direction;
      this.offset = 0;
      await this.load({ isReload: true });
    },

    // isReload distinguishes the very first, page-mount call (init(), below
    // -- a failure here leaves the page with nothing else to show, so it
    // gets a persistent inline banner) from every later action-triggered
    // call (switching tabs/filters, paging) -- a failure there leaves the
    // previous page's data still visible and functional, so a growl toast
    // (public/toast.js) is the better fit: it doesn't block anything, and
    // auto-dismisses instead of lingering until the user notices and
    // manually clears it.
    async load({ isReload = false } = {}) {
      this.error = null;
      try {
        if (this.directionFilter === 'blocked') {
          const res = await api.blocks();
          this.swipes = res.blocks.map((b) => ({ id: b.userId, name: b.displayName, direction: 'blocked' }));
          this.hasNext = false; // no pagination for blocks -- lists are expected to stay small
          this.total = res.blocks.length;
        } else {
          const res = await api.swipeHistory(this.mode, PAGE_SIZE, this.offset, this.directionFilter);
          this.swipes = res.swipes;
          this.total = res.total ?? null;
          // Now exact rather than inferred. The old `length === PAGE_SIZE`
          // heuristic offered a Next page whenever the total happened to be
          // a multiple of PAGE_SIZE, landing the user on an empty list.
          this.hasNext =
            res.total == null ? res.swipes.length === PAGE_SIZE : this.offset + res.swipes.length < res.total;
        }
      } catch (e) {
        const message = 'Could not load your swipe history. Please try again.';
        if (isReload) showErrorToast(message);
        else this.error = message;
      }
    },

    async next() {
      if (!this.hasNext) return;
      this.offset += PAGE_SIZE;
      scrollToTop();
      await this.load({ isReload: true });
    },

    async prev() {
      if (this.offset === 0) return;
      this.offset = Math.max(0, this.offset - PAGE_SIZE);
      scrollToTop();
      await this.load({ isReload: true });
    },

    async toggle(swipe) {
      const newDirection = swipe.direction === 'right' ? 'left' : 'right';
      try {
        await api.updateSwipe(this.mode, swipe.id, newDirection);
        swipe.direction = newDirection;
      } catch (e) {
        showErrorToast('Could not update that swipe. Please try again.');
      }
    },

    // `swipe.id` here is the blocked user's id (see load()'s mapping above),
    // not a people_swipes row id -- unblock() acts on the user, not a swipe.
    async unblock(swipe) {
      try {
        await api.unblock(swipe.id);
        this.swipes = this.swipes.filter((s) => s.id !== swipe.id);
      } catch (e) {
        showErrorToast('Could not unblock that person. Please try again.');
      }
    },
  };
}
