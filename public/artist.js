import { api } from './app.js';
import { requireAuth } from './auth.js';
import { play, togglePlayPause, isCurrentTrack as isCurrentTrackGlobal, onNowPlayingChange } from './playerBar.js';
import { showErrorToast } from './toast.js';

// Extracted from artist.html's inline script -- see matches.js's comment
// for why (same reasoning, same shape). Now needs a destroy() after all --
// see the nowPlayingTick/onNowPlayingChange comment below.

// Matches src/routes/catalog.ts's ARTIST_PROFILE_TRACK_LIMIT -- the server
// default this page starts at, and the increment each "Load more" tap adds
// on top of it.
const TRACKS_PAGE_SIZE = 30;

export function createArtistApp() {
  return {
    artistId: new URLSearchParams(window.location.search).get('id'),
    /** @type {{id: string, name: string, imageUrl?: string, genres: string[], totalLikes: number, totalLikesInArea: number, direction: string | null} | null} */
    artist: null,
    tracks: [],
    error: null,
    trackLimit: TRACKS_PAGE_SIZE,
    hasMoreTracks: false,
    loadingMore: false,

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
        const res = await api.artistProfile(this.artistId);
        this.artist = res.artist;
        this.tracks = res.tracks;
        this.hasMoreTracks = res.hasMore;
      } catch (e) {
        // Spotify's own rate limit (src/lib/spotify.ts's spotifyFetch), not
        // this app's -- distinguished so this doesn't read as the same
        // opaque failure as everything else. This artist likely has a
        // large catalog (loading one can fan out to dozens of Spotify
        // calls); it's worth telling the user that's specifically why,
        // rather than leaving them to guess whether retrying is pointless.
        this.error =
          e.body?.error === 'spotify_rate_limited'
            ? "Spotify's a little busy right now. Please try again in a moment."
            : 'Could not load this artist. Please try again.';
      }
    },

    destroy() {
      this.unsubscribeNowPlaying?.();
      this.unsubscribeNowPlaying = null;
    },

    // GET /api/artists/:id has no offset/cursor to resume from
    // (fetchArtistTracks re-derives the list from scratch each call), so
    // this re-fetches the whole thing at a higher limit rather than
    // appending an incremental page.
    async loadMoreTracks() {
      if (this.loadingMore || !this.hasMoreTracks) return;
      this.loadingMore = true;
      const nextLimit = this.trackLimit + TRACKS_PAGE_SIZE;
      try {
        const res = await api.artistProfile(this.artistId, nextLimit);
        this.trackLimit = nextLimit;
        this.tracks = res.tracks;
        this.hasMoreTracks = res.hasMore;
      } catch (e) {
        showErrorToast('Could not load more songs. Please try again.');
      } finally {
        this.loadingMore = false;
      }
    },

    async togglePlayer(track) {
      if (isCurrentTrackGlobal(track.spotifyId)) {
        await togglePlayPause();
        return;
      }
      // Every track on this page belongs to the one artist this.artist
      // already holds -- no per-track artist name in GET /api/artists/:id's
      // response shape, so it's supplied from the page's own state instead.
      await play({ spotifyId: track.spotifyId, id: track.id, name: track.name, artistName: this.artist?.name ?? null, imageUrl: track.imageUrl, durationMs: track.durationMs ?? null });
    },

    async swipeTrack(track, direction) {
      const previous = track.direction;
      track.direction = direction; // optimistic
      try {
        await api.swipe('music', { item_type: 'track', item_id: track.id, direction });
      } catch (e) {
        track.direction = previous;
        showErrorToast('Could not save that. Please try again.');
      }
    },

    // Likes the artist as a whole -- the same swipe a right-swipe in the
    // Music-mode deck records (src/routes/musicSwipes.ts), just reachable
    // directly from the profile page too. No separate "unlike" affordance,
    // same as the per-track like buttons above: tapping again while already
    // liked just re-sends 'right', which POST /api/swipe/music already
    // treats as a no-op (transition-based affinity tracking).
    async likeArtist() {
      if (!this.artist || this.artist.direction === 'right') return;
      const previous = this.artist.direction;
      this.artist.direction = 'right'; // optimistic
      try {
        await api.swipe('music', { item_type: 'artist', item_id: this.artist.id, direction: 'right' });
      } catch (e) {
        this.artist.direction = previous;
        showErrorToast('Could not save that. Please try again.');
      }
    },
  };
}
