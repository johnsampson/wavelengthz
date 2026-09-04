import { api } from './app.js';
import { requireAuth } from './auth.js';
import { play, togglePlayPause, isCurrentTrack as isCurrentTrackGlobal, onNowPlayingChange } from './playerBar.js';
import { showErrorToast } from './toast.js';
import { createReasonDialog } from './reasonDialog.js';

// Extracted from profile.html's inline script -- named personProfile.js
// (not profile.js) to avoid confusion with the already-existing
// public/settings/profile.js. Now needs a destroy() after all -- see the
// nowPlayingTick/onNowPlayingChange comment below.
const PAGE_SIZE = 6;

export function createPersonProfileApp() {
  return {
    ...createReasonDialog(),
    userId: new URLSearchParams(window.location.search).get('id'),
    /** @type {{displayName?: string, photoUrls: string[], isSelf?: boolean, anthemTrack?: {id: string, name?: string} | null, [key: string]: unknown} | null} */
    profile: null,
    overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [] },
    error: null,
    PAGE_SIZE,
    visibleArtistsCount: PAGE_SIZE,
    visibleTracksCount: PAGE_SIZE,
    // Shared by the inline carousel and the full-screen lightbox -- both
    // just show profile.photoUrls[carouselIndex], so paging through one
    // keeps the other in sync whichever gets opened.
    carouselIndex: 0,
    lightboxOpen: false,

    // Bumped every time playerBar.js reports the active track changed (a tap
    // here, elsewhere, or radio auto-advancing) -- referencing it inside
    // isCurrentTrack gives Alpine an actual reactive dependency to re-run the
    // track rows' play/pause icons on, since isCurrentTrackGlobal() itself
    // reads playerBar.js's own module state rather than anything on this
    // component. Same "value doesn't matter, only that it changed" idiom as
    // messages.js/group.js's `now = Date.now()` re-evaluating canRecall().
    nowPlayingTick: 0,
    unsubscribeNowPlaying: null,
    isCurrentTrack(spotifyId) {
      void this.nowPlayingTick;
      return isCurrentTrackGlobal(spotifyId);
    },

    async init() {
      if (!(await requireAuth())) return;
      this.unsubscribeNowPlaying = onNowPlayingChange(() => {
        this.nowPlayingTick++;
      });
      try {
        const res = await api.personProfile(this.userId);
        this.profile = res.profile;
        this.overlap = res.overlap;
      } catch (e) {
        this.error = 'Could not load this profile. Please try again.';
      }
    },

    destroy() {
      this.unsubscribeNowPlaying?.();
      this.unsubscribeNowPlaying = null;
    },

    // Playback happens in the fixed player bar (public/playerBar.js) above
    // the bottom nav, shared across all three track lists on this page
    // (top/shared/recent) the same way it's shared across every other page
    // that shows tracks.
    async togglePlayer(track) {
      if (isCurrentTrackGlobal(track.spotifyId)) {
        await togglePlayPause();
        return;
      }
      // All three lists on this page (top/shared/recent) share the same
      // {id, spotifyId, name, artistName, imageUrl} shape now, so this
      // works uniformly regardless of which one `track` came from.
      await play({ spotifyId: track.spotifyId, id: track.id, name: track.name, artistName: track.artistName, imageUrl: track.imageUrl });
    },

    // Clicking the currently-set anthem again clears it (trackId: null) --
    // there's no separate "remove" affordance, same toggle either way.
    async toggleAnthem(track) {
      const next = this.profile.anthemTrack?.id === track.id ? null : track.id;
      try {
        await api.setAnthem(next);
        this.profile.anthemTrack = next ? track : null;
      } catch (e) {
        showErrorToast('Could not update your anthem. Please try again.');
      }
    },

    openLightbox() {
      this.lightboxOpen = true;
    },

    closeLightbox() {
      this.lightboxOpen = false;
    },

    nextPhoto() {
      this.carouselIndex = (this.carouselIndex + 1) % this.profile.photoUrls.length;
    },

    prevPhoto() {
      this.carouselIndex = (this.carouselIndex - 1 + this.profile.photoUrls.length) % this.profile.photoUrls.length;
    },

    // Issue #173: replaces the old bare prompt() that never even captured
    // an "other" detail -- reasonDialog.js's shared picker, opened via
    // openReportDialog() from profile.html. Reports here can cover anything
    // on the profile (photos, bio) since the report itself just targets the
    // user, same as everywhere else reporting exists.
    async reasonDialogSubmit(_mode, reason, details) {
      try {
        await api.report(this.userId, reason, details);
        this.closeReasonDialog();
      } catch (e) {
        showErrorToast('Could not submit that report. Please try again.');
      }
    },
  };
}
