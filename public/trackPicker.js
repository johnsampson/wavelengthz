import { api } from './app.js';
import { debounce } from './search.js';
import { showErrorToast } from './toast.js';
import { play, togglePlayPause, isCurrentTrack } from './playerBar.js';

// Shared by messages.js (1:1 match threads) and group.js (group threads) --
// sharing a song, and the running playlist it accumulates into, work
// identically in both, so this exists rather than the same ~150 lines twice.
// Same consolidation reasoning as playerBar.js replacing the five duplicated
// inline player blocks.
//
// Mixed into a page's Alpine app via spread, with the two thread-specific
// calls injected: `share(track, caption)` and `loadPlaylist()`.

/**
 * @param {{ share: (track: any, body: string) => Promise<any>, loadPlaylist: () => Promise<{tracks: any[], count: number}> }} deps
 */
export function createTrackPicker(deps) {
  return {
    showTrackPicker: false,
    trackQuery: '',
    trackResults: [],
    trackSearching: false,
    trackCaption: '',
    sharingTrack: false,
    /** @type {{spotifyTrackId: string, name: string, artistName: string | null, imageUrl: string | null} | null} */
    nowPlaying: null,
    /** Raw Spotify object for nowPlaying -- what the share call actually sends. */
    nowPlayingRaw: null,
    debouncedTrackSearch: null,

    showPlaylist: false,
    playlistTracks: [],
    playlistCount: 0,

    isCurrentTrack,

    initTrackPicker() {
      this.debouncedTrackSearch = debounce(() => this.runTrackSearch(), 300);
    },

    async openTrackPicker() {
      this.showTrackPicker = true;
      this.trackQuery = '';
      this.trackResults = [];
      this.trackCaption = '';
      // Fetched on open rather than on page load: it's a live Spotify call
      // per open, and it goes stale within a song's length anyway, so
      // fetching it up front would be both wasteful and frequently wrong.
      // Silently leaves nowPlaying null on any failure -- the button just
      // doesn't appear and search still works.
      this.nowPlaying = null;
      this.nowPlayingRaw = null;
      try {
        const res = await api.nowPlaying();
        if (res.playing) {
          this.nowPlaying = res.playing;
          this.nowPlayingRaw = res.track;
        }
      } catch (e) {
        // Not connected to Spotify, nothing playing, or a transient failure.
      }
      this.$nextTick(() => this.$refs.trackSearchInput?.focus());
    },

    closeTrackPicker() {
      this.showTrackPicker = false;
      this.trackQuery = '';
      this.trackResults = [];
      this.trackCaption = '';
    },

    onTrackQueryInput() {
      if (this.trackQuery.trim().length < 2) {
        this.trackResults = [];
        return;
      }
      this.debouncedTrackSearch();
    },

    async runTrackSearch() {
      this.trackSearching = true;
      try {
        const res = await api.trackSearch(this.trackQuery.trim());
        this.trackResults = res.results;
      } catch (e) {
        showErrorToast('Could not search right now. Please try again.');
      } finally {
        this.trackSearching = false;
      }
    },

    /**
     * A search result carries only the fields needed to render it; the server
     * needs the full Spotify object to resolve the track into the catalog.
     * For a result that's already cataloged we can send a minimal object
     * (the server short-circuits on spotify_id before touching artists[]);
     * for a live Spotify result the full object was returned alongside it.
     */
    async shareSearchResult(result) {
      await this.shareTrack({
        id: result.spotifyTrackId,
        name: result.name,
        artists: result.artistName ? [{ id: result.spotifyArtistId ?? '', name: result.artistName }] : [],
        album: { images: result.imageUrl ? [{ url: result.imageUrl }] : [] },
      });
    },

    async shareNowPlaying() {
      if (!this.nowPlayingRaw) return;
      await this.shareTrack(this.nowPlayingRaw);
    },

    async shareTrack(track) {
      if (this.sharingTrack) return;
      this.sharingTrack = true;
      const caption = this.trackCaption.trim();
      try {
        await deps.share(track, caption);
        this.closeTrackPicker();
        await this.load();
        await this.refreshPlaylist();
        this.$nextTick(() => this.scrollToBottom?.());
      } catch (e) {
        if (e.status === 503 && e.body?.error === 'artist_unavailable') {
          showErrorToast("Spotify's a little busy right now. Please try again in a moment.");
        } else if (e.status === 403 && e.body?.error === 'profile_incomplete') {
          showErrorToast('Finish setting up messaging in Settings → Messaging before sending.');
        } else if (e.status === 400) {
          showErrorToast("That caption isn't allowed. Please rephrase it.");
        } else {
          showErrorToast('Could not share that song. Please try again.');
        }
      } finally {
        this.sharingTrack = false;
      }
    },

    async refreshPlaylist() {
      try {
        const res = await deps.loadPlaylist();
        this.playlistTracks = res.tracks;
        this.playlistCount = res.count;
      } catch (e) {
        // Non-fatal -- the thread itself still renders; only the count chip
        // goes stale.
      }
    },

    togglePlaylist() {
      this.showPlaylist = !this.showPlaylist;
    },

    /**
     * Plays a shared track through the persistent player bar, so it keeps
     * playing while you carry on scrolling the thread (or navigate away
     * entirely). Same toggle semantics as every other play affordance in the
     * app: tapping the track that's already playing pauses it.
     */
    async playSharedTrack(track) {
      if (!track) return;
      if (isCurrentTrack(track.spotifyId)) {
        await togglePlayPause();
        return;
      }
      await play({
        spotifyId: track.spotifyId,
        id: track.id,
        name: track.name,
        artistName: track.artistName,
        imageUrl: track.imageUrl,
      });
    },
  };
}
