import { api } from './app.js';
import { requireAuth } from './auth.js';
import { shouldSearch, debounce } from './search.js';
import { showErrorToast, showToast } from './toast.js';
import { play, togglePlayPause, isCurrentTrack as isCurrentTrackGlobal, onNowPlayingChange } from './playerBar.js';
import { navigate } from './router.js';

export function createDropApp() {
  return {
    loading: true,
    error: null,
    prompt: null,
    myAnswer: null,
    answerCount: 0,
    /** @type {Array<{userId: string, displayName: string | null, photoUrl: string | null, track: {name: string, artistName: string | null, spotifyId: string, imageUrl: string | null}}>} */
    answers: [],
    answersLoading: false,

    searchQuery: '',
    searchResults: [],
    searching: false,
    submitting: false,
    debouncedSearch: null,

    // Bumped every time playerBar.js reports the active track changed (a tap
    // here, elsewhere, or radio auto-advancing) -- referencing it inside
    // isCurrentTrack gives Alpine an actual reactive dependency to re-run the
    // answer rows' play/pause icons on, since isCurrentTrackGlobal() itself
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
      this.debouncedSearch = debounce(() => this.runSearch(), 300);
      try {
        const res = await api.dailyDrop();
        this.prompt = res.prompt;
        this.myAnswer = res.myAnswer;
        this.answerCount = res.answerCount;
      } catch (e) {
        this.error = 'Could not load today’s prompt right now. Please reload the page.';
      } finally {
        this.loading = false;
      }
      // Only worth fetching once there's something to browse -- an answered
      // day always has answerCount >= 1 (yourself), so this covers "already
      // answered" too, without a second round trip on first paint for
      // everyone who hasn't answered yet.
      if (this.answerCount > 0) await this.loadAnswers();
    },

    async loadAnswers() {
      this.answersLoading = true;
      try {
        const res = await api.dailyDropAnswers();
        this.answers = res.answers;
      } catch (e) {
        // Non-fatal -- the prompt and answer box above still work; only the
        // browse list goes stale/empty.
      } finally {
        this.answersLoading = false;
      }
    },

    onSearchInput() {
      if (!shouldSearch(this.searchQuery)) {
        this.searchResults = [];
        return;
      }
      this.debouncedSearch();
    },

    async runSearch() {
      this.searching = true;
      try {
        const res = await api.trackSearch(this.searchQuery.trim());
        this.searchResults = res.results;
      } catch (e) {
        showErrorToast('Could not search right now. Please try again.');
      } finally {
        this.searching = false;
      }
    },

    /**
     * A search result carries only display fields; the server needs the
     * full Spotify object to resolve it into the catalog in one round trip
     * (src/lib/trackSharing.ts). Same reconstruction as trackPicker.js's
     * shareSearchResult -- kept separate here since this page has no use
     * for that mixin's caption/playlist/now-playing pieces.
     */
    async selectAnswer(result) {
      if (this.submitting) return;
      this.submitting = true;
      try {
        const res = await api.submitDailyDropAnswer({
          id: result.spotifyTrackId,
          name: result.name,
          artists: result.artistName ? [{ id: result.spotifyArtistId ?? '', name: result.artistName }] : [],
          album: { images: result.imageUrl ? [{ url: result.imageUrl }] : [] },
        });
        // Issue #170: fire-and-forget, same as every other recordEvent call.
        api.recordEvent('daily_drop_answered').catch(() => {});
        this.myAnswer = res.myAnswer;
        this.answerCount = Math.max(this.answerCount, 1);
        this.searchQuery = '';
        this.searchResults = [];
        showToast({ message: 'Answer saved', icon: '\u{1F3B5}' });
        this.loadAnswers();
      } catch (e) {
        if (e.status === 503 && e.body?.error === 'artist_unavailable') {
          showErrorToast("Spotify's a little busy right now. Please try again in a moment.");
        } else {
          showErrorToast('Could not save that answer. Please try again.');
        }
      } finally {
        this.submitting = false;
      }
    },

    async playTrack(track) {
      if (!track) return;
      if (isCurrentTrackGlobal(track.spotifyId)) {
        await togglePlayPause();
      } else {
        await play({ spotifyId: track.spotifyId, name: track.name, imageUrl: track.imageUrl });
      }
    },

    viewProfile(userId) {
      navigate(`/profile?id=${userId}`);
    },

    destroy() {
      this.unsubscribeNowPlaying?.();
      this.unsubscribeNowPlaying = null;
    },
  };
}
