import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';
import { navigate } from './router.js';
import { debounce } from './search.js';
import { focusAfterReveal } from './domUtils.js';

// Extracted from groups.html's inline script -- see matches.js's comment
// for why (same reasoning, same shape).
export function createGroupsApp() {
  return {
    groups: [],
    error: null,
    showCreate: false,
    newName: '',
    newTopic: '',

    // Optional seed track (issue #127: "Start a group from a song. The song
    // should be fixed at the bottom of the chat."). Deliberately NOT
    // trackPicker.js's createTrackPicker mixin -- that one shares a track
    // into an ALREADY-EXISTING thread the moment it's picked (deps.share),
    // then reloads that thread's own message list/playlist. Here a song is
    // picked before the group (and its id) even exist, and just needs to
    // ride along in the eventual POST /api/groups body -- a different
    // enough lifecycle that force-fitting the mixin (a dummy load()/
    // scrollToBottom() just to satisfy its post-share side effects) would
    // be more confusing than this small, purpose-built version.
    showSongPicker: false,
    songQuery: '',
    songResults: [],
    songSearching: false,
    debouncedSongSearch: null,
    /** @type {{name: string, artistName: string | null, imageUrl: string | null} | null} */
    selectedSong: null,
    /** Raw Spotify object for selectedSong -- what create() actually sends. */
    selectedSongRaw: null,

    async init() {
      if (!(await requireAuth())) return;
      this.debouncedSongSearch = debounce(() => this.runSongSearch(), 300);
      await this.load();
    },

    async load() {
      this.error = null;
      try {
        const res = await api.groups();
        this.groups = res.groups;
      } catch (e) {
        this.error = 'Could not load groups. Please try again.';
      }
    },

    openSongPicker() {
      this.showSongPicker = true;
      this.songQuery = '';
      this.songResults = [];
      // Focused before any await, not after -- see trackPicker.js's
      // openTrackPicker() / domUtils.js's focusAfterReveal for why (issue
      // #108/#127: opening a reveal-then-focus modal any other way never
      // reliably opens iOS's own keyboard).
      focusAfterReveal(this.$nextTick.bind(this), this.$refs.songSearchInput);
    },

    closeSongPicker() {
      this.showSongPicker = false;
      this.songQuery = '';
      this.songResults = [];
    },

    onSongQueryInput() {
      if (this.songQuery.trim().length < 2) {
        this.songResults = [];
        return;
      }
      this.debouncedSongSearch();
    },

    async runSongSearch() {
      this.songSearching = true;
      try {
        const res = await api.trackSearch(this.songQuery.trim());
        this.songResults = res.results;
      } catch (e) {
        showErrorToast('Could not search right now. Please try again.');
      } finally {
        this.songSearching = false;
      }
    },

    // A search result carries only the fields needed to render it; POST
    // /api/groups needs the full Spotify object to resolve the track into
    // the catalog -- same split trackPicker.js's shareSearchResult uses.
    pickSong(result) {
      this.selectedSong = { name: result.name, artistName: result.artistName ?? null, imageUrl: result.imageUrl ?? null };
      this.selectedSongRaw = {
        id: result.spotifyTrackId,
        name: result.name,
        artists: result.artistName ? [{ id: result.spotifyArtistId ?? '', name: result.artistName }] : [],
        album: { images: result.imageUrl ? [{ url: result.imageUrl }] : [] },
      };
      this.closeSongPicker();
    },

    clearSelectedSong() {
      this.selectedSong = null;
      this.selectedSongRaw = null;
    },

    async create() {
      if (!this.newName.trim()) return;
      this.error = null;
      try {
        await api.createGroup(this.newName.trim(), this.newTopic.trim() || null, this.selectedSongRaw ?? undefined);
        // Issue #170: fire-and-forget, same as every other recordEvent call.
        api.recordEvent('group_created').catch(() => {});
        this.newName = '';
        this.newTopic = '';
        this.showCreate = false;
        this.clearSelectedSong();
        await this.load();
      } catch (e) {
        if (e.status === 503 && e.body?.error === 'artist_unavailable') {
          showErrorToast("Spotify's a little busy right now. Please try again in a moment.");
        } else {
          showErrorToast('Could not create that group. Please try again.');
        }
      }
    },

    async join(g) {
      this.error = null;
      try {
        await api.joinGroup(g.id);
        // Issue #170: fire-and-forget, same as every other recordEvent call.
        api.recordEvent('group_joined').catch(() => {});
        await navigate(`/group?id=${g.id}`);
      } catch (e) {
        if (e.status === 403 && e.body?.error === 'group_full') {
          showErrorToast('That group is full.');
        } else if (e.status === 403 && e.body?.error === 'blocked') {
          showErrorToast('Could not join that group.');
        } else {
          showErrorToast('Could not join that group. Please try again.');
        }
      }
    },
  };
}
