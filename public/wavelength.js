import { api } from './app.js';
import { requireAuth } from './auth.js';

export function createWavelengthApp() {
  return {
    drift: null,
    error: null,
    loading: true,

    async init() {
      if (!(await requireAuth())) return;
      try {
        this.drift = await api.tasteDrift();
      } catch (e) {
        this.error = 'Could not load your wavelength right now. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    /**
     * The one-line summary at the top. Deliberately says nothing at all when
     * there isn't enough listening to support a claim -- a confident sentence
     * built on two swipes is what makes this kind of feature feel fake.
     */
    get headline() {
      if (!this.drift || this.drift.insufficientData) return '';
      const top = this.drift.rising[0];
      if (top) return `Your wavelength moved toward ${top.genre} this month.`;
      if (this.drift.falling[0]) return `You have been playing less ${this.drift.falling[0].genre} lately.`;
      return 'Your wavelength held steady this month.';
    },

    /** Signed, for display -- "+4" reads as movement where "4" reads as a total. */
    delta(entry) {
      return entry.change > 0 ? `+${entry.change}` : `${entry.change}`;
    },
  };
}
