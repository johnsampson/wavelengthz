import { api } from './app.js';
import { requireAuth } from './auth.js';

// Extracted from history.html's inline script so the pagination logic below
// is directly testable (same pattern as settings.js). The page just does
// `window.historyApp = createHistoryApp`.
export const PAGE_SIZE = 20;

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
        const res = await api.swipeHistory(this.mode, PAGE_SIZE, this.offset, this.directionFilter);
        this.swipes = res.swipes;
        this.hasNext = res.swipes.length === PAGE_SIZE;
      } catch (e) {
        this.error = 'Could not load your swipe history. Please try again.';
      }
    },

    async next() {
      if (!this.hasNext) return;
      this.offset += PAGE_SIZE;
      await this.load();
    },

    async prev() {
      if (this.offset === 0) return;
      this.offset = Math.max(0, this.offset - PAGE_SIZE);
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
  };
}
