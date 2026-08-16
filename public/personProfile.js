import { api } from './app.js';
import { requireAuth } from './auth.js';
import { play, togglePlayPause, isCurrentTrack } from './playerBar.js';
import { showErrorToast } from './toast.js';

// Extracted from profile.html's inline script -- named personProfile.js
// (not profile.js) to avoid confusion with the already-existing
// public/settings/profile.js. No destroy() needed -- nothing here starts a
// timer or attaches a listener outside Alpine's own bindings.
const PAGE_SIZE = 6;

export function createPersonProfileApp() {
  return {
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
    isCurrentTrack,

    async init() {
      if (!(await requireAuth())) return;
      try {
        const res = await api.personProfile(this.userId);
        this.profile = res.profile;
        this.overlap = res.overlap;
      } catch (e) {
        this.error = 'Could not load this profile. Please try again.';
      }
    },

    // Playback happens in the fixed player bar (public/playerBar.js) above
    // the bottom nav, shared across all three track lists on this page
    // (top/shared/recent) the same way it's shared across every other page
    // that shows tracks.
    async togglePlayer(track) {
      if (isCurrentTrack(track.spotifyId)) {
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

    // Same crude prompt-based flow as match.js's report() -- there's no
    // report UI anywhere in the app yet beyond this, so this matches rather
    // than reinvents it. Reports here can cover anything on the profile
    // (photos, bio) since the report itself just targets the user, same as
    // everywhere else reporting exists.
    async report() {
      const reason = prompt('Reason (inappropriate_photos, harassment, fake_profile, spam, underage, other):');
      if (!reason) return;
      try {
        await api.report(this.userId, reason);
      } catch (e) {
        showErrorToast('Could not submit that report. Please try again.');
      }
    },
  };
}
