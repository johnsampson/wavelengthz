import { api } from './app.js';
import { requireAuth } from './auth.js';

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

export function createHistoryApp() {
  return {
    mode: 'people',
    swipes: [],
    error: null,
    offset: 0,
    hasNext: false,
    directionFilter: null, // null = all, otherwise 'left' | 'right'
    get hasPrev() {
      return this.offset > 0;
    },

    async init() {
      if (!(await requireAuth())) return;
      await this.load();
    },

    async setMode(mode) {
      this.mode = mode;
      this.offset = 0;
      // "Blocked" is a people-only concept -- switching to music mode with it
      // still selected would silently try (and fail) to load music history.
      if (mode === 'music' && this.directionFilter === 'blocked') this.directionFilter = null;
      await this.load();
    },

    async setDirectionFilter(direction) {
      this.directionFilter = direction;
      this.offset = 0;
      await this.load();
    },

    async load() {
      this.error = null;
      try {
        if (this.directionFilter === 'blocked') {
          const res = await api.blocks();
          this.swipes = res.blocks.map((b) => ({ id: b.userId, name: b.displayName, direction: 'blocked' }));
          this.hasNext = false; // no pagination for blocks -- lists are expected to stay small
        } else {
          const res = await api.swipeHistory(this.mode, PAGE_SIZE, this.offset, this.directionFilter);
          this.swipes = res.swipes;
          this.hasNext = res.swipes.length === PAGE_SIZE;
        }
      } catch (e) {
        this.error = 'Could not load your swipe history. Please try again.';
      }
    },

    async next() {
      if (!this.hasNext) return;
      this.offset += PAGE_SIZE;
      scrollToTop();
      await this.load();
    },

    async prev() {
      if (this.offset === 0) return;
      this.offset = Math.max(0, this.offset - PAGE_SIZE);
      scrollToTop();
      await this.load();
    },

    async toggle(swipe) {
      this.error = null;
      const newDirection = swipe.direction === 'right' ? 'left' : 'right';
      try {
        await api.updateSwipe(this.mode, swipe.id, newDirection);
        swipe.direction = newDirection;
      } catch (e) {
        this.error = 'Could not update that swipe. Please try again.';
      }
    },

    // `swipe.id` here is the blocked user's id (see load()'s mapping above),
    // not a people_swipes row id -- unblock() acts on the user, not a swipe.
    async unblock(swipe) {
      this.error = null;
      try {
        await api.unblock(swipe.id);
        this.swipes = this.swipes.filter((s) => s.id !== swipe.id);
      } catch (e) {
        this.error = 'Could not unblock that person. Please try again.';
      }
    },
  };
}
