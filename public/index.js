import { api } from './app.js';
import { attachSwipeDeck } from './swipe.js';
import { getAuthedUser } from './auth.js';
import { shouldSearch, debounce, loadStoredMode, storeMode, saveSearchState, takeSearchState } from './search.js';
import { play, togglePlayPause, isCurrentTrack } from './playerBar.js';
import { showErrorToast } from './toast.js';

// Extracted from index.html's inline script -- see matches.js's comment for
// why (same reasoning, same shape). Also adds destroy(), same new
// requirement the router introduces as messages.js/group.js's poll timers:
// showNext() attaches a fresh swipe-deck pointer listener via
// attachSwipeDeck() on every card change, detaching the PREVIOUS one first
// -- but nothing previously detached the LAST one when leaving the page
// entirely (a real reload always did that for free). destroy() closes that
// gap the same way.
export function createDeckApp() {
  return {
    // Restored from localStorage (see search.js's own comment) rather than
    // always starting on 'people' -- switching to Music mode used to never
    // stick across a fresh page load (including the browser's back button
    // after tapping into a search result), forcing a manual re-toggle back
    // to Music every single time.
    mode: loadStoredMode(localStorage),
    queue: [],
    /** @type {{id?: string, itemType?: string, itemId?: string, name?: string, displayName?: string, imageUrl?: string, primaryPhotoUrl?: string, bio?: string, distanceLabel?: string, topGenres?: string[], anthemTrack?: {spotifyId: string, name: string, imageUrl?: string} | null} | null} */
    current: null,
    detachSwipe: null,
    authed: null,
    showSearch: false,
    searchQuery: '',
    searchResults: [],
    searching: false,
    debouncedSearch: null,
    matchModal: null,
    // Set to a genre name once the swipe response reports that genre's pass
    // count just crossed the threshold (src/routes/musicSwipes.ts); null
    // the rest of the time.
    genrePrompt: null,

    // Reads playerBar.js's own module state rather than keeping a local
    // copy -- true exactly when the current card's anthem is the track
    // actually playing in the fixed bar.
    isCurrentAnthem() {
      return !!this.current?.anthemTrack && isCurrentTrack(this.current.anthemTrack.spotifyId);
    },

    async init() {
      const user = await getAuthedUser();
      this.authed = !!user;
      if (this.authed) {
        await this.loadQueue();
        // Reopens the search modal with its previous query/results if this
        // load is the return trip from tapping into a search result
        // (selectArtist saves it right before navigating away, below) --
        // otherwise search.js's takeSearchState finds nothing and this is a
        // no-op, same as any other ordinary visit to the deck.
        if (this.mode === 'music') {
          const saved = takeSearchState(sessionStorage);
          if (saved) {
            this.searchQuery = saved.query;
            this.searchResults = saved.results;
            this.showSearch = true;
          }
        }
      }
      this.debouncedSearch = debounce(() => this.runSearch(), 300);
    },

    destroy() {
      if (this.detachSwipe) {
        this.detachSwipe();
        this.detachSwipe = null;
      }
    },

    async setMode(mode) {
      this.mode = mode;
      storeMode(localStorage, mode);
      this.queue = [];
      this.current = null;
      // Deliberately does not stop whatever's playing in the fixed player
      // bar -- switching mode (or swiping to the next card, below) is not
      // an explicit "stop" action, matching this app's "only an explicit
      // tap changes the active track" rule for the bar everywhere else.
      await this.loadQueue();
    },

    async loadQueue() {
      const res = await api.candidates(this.mode, 10);
      this.queue = res.candidates;
      this.showNext();
    },

    async showNext() {
      if (this.detachSwipe) this.detachSwipe();
      this.current = this.queue.shift() ?? null;
      this.$nextTick(() => {
        const card = document.getElementById('card');
        if (card && this.current) {
          this.detachSwipe = attachSwipeDeck(card, { onSwipe: (dir) => this.decide(dir) });
        }
      });
    },

    async decide(direction) {
      if (!this.current) return;
      const swiped = this.current;
      try {
        if (this.mode === 'people') {
          const res = await api.swipe('people', { target_id: swiped.id, direction });
          if (res.matched) {
            // Hold on the celebration instead of immediately advancing --
            // dismissMatch() (or the deck's own showNext/loadQueue logic)
            // moves to the next candidate once the user is ready.
            this.matchModal = { name: swiped.displayName, photoUrl: swiped.primaryPhotoUrl, matchId: res.matchId };
            return;
          }
        } else {
          const res = await api.swipe('music', { item_type: swiped.itemType, item_id: swiped.itemId, direction });
          // Shown once the queue/card transition below has already moved
          // on -- the prompt is about a genre in general, not this specific
          // card, so it doesn't need to block advancing.
          if (res.crossedGenre) this.genrePrompt = res.crossedGenre;
        }
      } catch (e) {
        // Leave `current` in place either way -- the swipe didn't save, so
        // advancing would silently drop it instead of letting the user
        // retry.
        showErrorToast(
          e.status === 429 ? "You're swiping too fast -- wait a moment and try again." : 'Could not save that. Please try again.'
        );
        return;
      }
      if (this.queue.length === 0) await this.loadQueue();
      else this.showNext();
    },

    async dismissMatch() {
      this.matchModal = null;
      if (this.queue.length === 0) await this.loadQueue();
      else this.showNext();
    },

    async blockGenrePrompt() {
      const genre = this.genrePrompt;
      this.genrePrompt = null;
      try {
        await api.blockGenre(genre);
      } catch (e) {
        // Non-fatal -- the deck already moved on by the time this prompt
        // appears, so a failed block just means the genre keeps showing
        // up; nothing here to roll back or retry inline.
        showErrorToast('Could not hide that genre. You can try again from Settings → Preferences.');
      }
    },

    openSearch() {
      this.showSearch = true;
      // The plain `autofocus` attribute only fires once, on the initial
      // (hidden) page load -- this element never re-parses when x-show
      // later reveals it, so it silently did nothing. $nextTick waits for
      // Alpine to actually flip the modal's `display` before focusing,
      // otherwise .focus() on a still-hidden input is a no-op too.
      this.$nextTick(() => this.$refs.searchInput?.focus());
    },

    closeSearch() {
      this.showSearch = false;
      this.searchQuery = '';
      this.searchResults = [];
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
        const res = await api.artistSearch(this.searchQuery.trim());
        this.searchResults = res.results;
      } catch (e) {
        showErrorToast('Could not search right now. Please try again.');
      } finally {
        this.searching = false;
      }
    },

    async selectArtist(result) {
      // Saved right before leaving the deck entirely (this is a real
      // navigation, not an SPA route change) so init()'s own
      // takeSearchState call can reopen this same search on the way back --
      // see search.js's own comment on why this landed the user somewhere
      // unhelpful (defaulting back to People mode, with no memory of what
      // they'd searched) instead.
      saveSearchState(sessionStorage, { query: this.searchQuery, results: this.searchResults });

      // Already cataloged -- result.id is our internal artist UUID.
      if (result.inCatalog) {
        window.location.href = `/artist?id=${result.id}`;
        return;
      }
      // A live Spotify result has no internal id yet (see GET
      // /api/artists/search's `inCatalog: false` shape) -- persist it first
      // so there's a real artist row (and UUID) to navigate to.
      try {
        const res = await api.createArtist(result.spotifyArtistId);
        window.location.href = `/artist?id=${res.artistId}`;
      } catch (e) {
        showErrorToast('Could not add that artist. Please try again.');
      }
    },

    viewProfile() {
      if (!this.current) return;
      window.location.href = `/profile?id=${this.current.id}`;
    },

    async toggleAnthem() {
      if (!this.current?.anthemTrack) return;
      if (this.isCurrentAnthem()) {
        await togglePlayPause();
        return;
      }
      const { spotifyId, name, imageUrl } = this.current.anthemTrack;
      await play({ spotifyId, name, imageUrl });
    },
  };
}
