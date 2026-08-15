import { api } from './app.js';
import { requireAuth } from './auth.js';
import { play, togglePlayPause, isCurrentTrack } from './playerBar.js';
import { showErrorToast } from './toast.js';

// Extracted from artist.html's inline script -- see matches.js's comment
// for why (same reasoning, same shape). No destroy() needed -- nothing here
// starts a timer or attaches a listener outside Alpine's own bindings.

// Matches src/routes/catalog.ts's ARTIST_PROFILE_TRACK_LIMIT -- the server
// default this page starts at, and the increment each "Load more" tap adds
// on top of it.
const TRACKS_PAGE_SIZE = 30;

export function createArtistApp() {
  return {
    artistId: new URLSearchParams(window.location.search).get('id'),
    /** @type {{id: string, name: string, imageUrl?: string, genres: string[], totalLikes: number, totalLikesInArea: number} | null} */
    artist: null,
    tracks: [],
    error: null,
    trackLimit: TRACKS_PAGE_SIZE,
    hasMoreTracks: false,
    loadingMore: false,
    isCurrentTrack,

    async init() {
      if (!(await requireAuth())) return;
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
      if (isCurrentTrack(track.spotifyId)) {
        await togglePlayPause();
        return;
      }
      await play({ spotifyId: track.spotifyId, name: track.name, imageUrl: track.imageUrl });
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
  };
}
