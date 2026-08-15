import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';

// Extracted from match.html's inline script -- see matches.js's comment for
// why (same reasoning, same shape).
export function createMatchApp() {
  return {
    matchId: new URLSearchParams(window.location.search).get('id'),
    /** @type {{id: string, otherUserId: string, otherDisplayName?: string} | null} */
    match: null,
    overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [] },
    error: null,

    async init() {
      if (!(await requireAuth())) return;
      try {
        const res = await api.matchDetail(this.matchId);
        this.match = res.match;
        this.overlap = res.overlap;
      } catch (e) {
        this.error = 'Could not load this match. Please try again.';
      }
    },

    async unmatch() {
      try {
        await api.unmatch(this.matchId);
        window.location.href = '/matches';
      } catch (e) {
        showErrorToast('Could not unmatch. Please try again.');
      }
    },

    async block() {
      try {
        await api.block(this.match.otherUserId);
        window.location.href = '/matches';
      } catch (e) {
        showErrorToast('Could not block that user. Please try again.');
      }
    },

    async report() {
      const reason = prompt('Reason (inappropriate_photos, harassment, fake_profile, spam, underage, other):');
      if (!reason) return;
      try {
        await api.report(this.match.otherUserId, reason);
      } catch (e) {
        showErrorToast('Could not submit that report. Please try again.');
      }
    },
  };
}
