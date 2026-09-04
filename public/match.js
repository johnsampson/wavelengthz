import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';
import { navigate } from './router.js';
import { createReasonDialog } from './reasonDialog.js';

// Extracted from match.html's inline script -- see matches.js's comment for
// why (same reasoning, same shape).
export function createMatchApp() {
  return {
    ...createReasonDialog(),
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
        await navigate('/matches');
      } catch (e) {
        showErrorToast('Could not unmatch. Please try again.');
      }
    },

    // Issue #173: block/report both now go through reasonDialog.js's shared
    // picker (opened via openBlockDialog()/openReportDialog() from
    // match.html) instead of a bare confirm/prompt with no reason captured.
    async reasonDialogSubmit(mode, reason, details) {
      try {
        if (mode === 'block') {
          await api.block(this.match.otherUserId, reason, details);
          this.closeReasonDialog();
          await navigate('/matches');
        } else {
          await api.report(this.match.otherUserId, reason, details);
          this.closeReasonDialog();
        }
      } catch (e) {
        showErrorToast(mode === 'block' ? 'Could not block that user. Please try again.' : 'Could not submit that report. Please try again.');
      }
    },
  };
}
