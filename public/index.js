import { api } from './app.js';
import { attachSwipeDeck } from './swipe.js';
import { getAuthedUser } from './auth.js';
import { shouldSearch, debounce, loadStoredMode, storeMode, saveSearchState, takeSearchState } from './search.js';
import { play, togglePlayPause, isCurrentTrack, onNowPlayingChange } from './playerBar.js';
import { showToast, showErrorToast } from './toast.js';
import { revealAndFocusSync } from './domUtils.js';
import { navigate } from './router.js';

/** @typedef {{id?: string, itemType?: string, itemId?: string, name?: string, displayName?: string, imageUrl?: string, primaryPhotoUrl?: string, bio?: string, distanceLabel?: string, topGenres?: string[], anthemTrack?: {spotifyId: string, id?: string, name: string, artistName?: string | null, imageUrl?: string} | null, track?: {spotifyId: string, id: string, name: string, imageUrl?: string, durationMs?: number | null} | null}} Candidate */

/**
 * Warms the browser's image cache for a candidate about to become `current`,
 * so the actual `:src` swap in showNext() below resolves from cache instead
 * of a fresh network fetch. Exists because swipe.js's attachSwipeDeck reuses
 * the same `<img>` element across cards in place -- until a newly assigned
 * `src` finishes loading, the element keeps rendering whatever it last
 * successfully decoded, so on a slow connection the PREVIOUS candidate's
 * photo visibly reappears, centered, for a moment before the real one loads
 * in (issue #108: "on a slower connection... the artist picture reappears
 * for a brief second... let's not do that"). Called while the candidate
 * still has a full swipe's worth of dwell time as `queue[0]`, same
 * "prefetch ahead of an actual visit" reasoning as showNext()'s existing
 * artist-profile prefetch, just for the image itself rather than catalog
 * data -- and unlike that one, this runs in both modes, since the flash
 * this fixes affects People-mode photos and Music-mode artist art equally.
 *
 * Guarded for `Image` being undefined -- true in this test pool
 * (@cloudflare/vitest-pool-workers has no browser globals at all), same
 * reasoning as domUtils.js's raf().
 *
 * @param {Candidate | undefined} candidate
 * @param {'music' | 'people'} mode
 */
export function preloadCandidateImage(candidate, mode) {
  if (typeof Image === 'undefined') return;
  const url = mode === 'music' ? candidate?.imageUrl : candidate?.primaryPhotoUrl;
  if (!url) return;
  new Image().src = url;
}

// Issue #161 (part of the 250K-users strategy discussion): once per real
// session (not once per SPA navigation -- sessionStorage survives
// router.js's in-place page swaps and a reload within the same tab, and is
// cleared when the tab closes), record that someone showed up at all.
// Fire-and-forget -- a failed/slow analytics call must never affect the
// deck loading, same reasoning as loadDailyDropPrompt()'s own try/catch.
// Works for a logged-out visitor too -- attribution to a real account (if
// any) happens server-side off the session cookie, not anything passed
// here.
function recordSessionStartOnce() {
  if (sessionStorage.getItem('wl_session_start_recorded')) return;
  sessionStorage.setItem('wl_session_start_recorded', '1');
  api.recordEvent('session_start').catch(() => {});
}

// Mounts the deck card's own inline Spotify embed for its representative
// track -- issue #159/#160 (part of the 250K-users strategy discussion): a
// visible, ready-to-tap (autoplay where the browser allows it) embed
// directly on the card, replacing the old text chip that only handed off
// to the shared player bar. Built via createElement + property assignment,
// not an innerHTML string, so a track id never passes through HTML
// parsing -- same reasoning as playerBar.js's own showIframe. Spotify's
// embed exposes no JS API to redirect an existing iframe to a different
// track, so a track change always means destroying and recreating this
// element, same as playerBar.js's own iframe does for the bar.
function showCardPreviewEmbed(spotifyId) {
  const host = document.getElementById('wl-card-preview-host');
  if (!host) return;
  host.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = `https://open.spotify.com/embed/track/${spotifyId}?theme=0&autoplay=1`;
  iframe.width = '100%';
  iframe.height = '80';
  iframe.frameBorder = '0';
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  iframe.loading = 'lazy';
  iframe.className = 'rounded-xl';
  host.appendChild(iframe);
  host.classList.remove('hidden');
  // Issue #161: mounting this embed is the Music-mode equivalent of the
  // old togglePreviewTrack()'s "fresh play" branch -- issue #160 replaced
  // that hand-off-to-the-shared-bar chip with this self-contained embed,
  // so the song_play event moves here with it. Fire-and-forget, same
  // reasoning as recordSessionStartOnce above.
  api.recordEvent('song_play', { spotifyId }).catch(() => {});
}

// Fully empties the host rather than just hiding it -- an iframe merely
// hidden via CSS keeps its browsing context alive and keeps playing in the
// background, the exact bug public/sw.js's own v7 changelog entry
// documents fixing for the player bar's own iframe. Called whenever the
// deck advances to a candidate with no track, the mode switches away from
// Music, or the page itself is torn down.
function hideCardPreviewEmbed() {
  const host = document.getElementById('wl-card-preview-host');
  if (!host) return;
  host.classList.add('hidden');
  host.innerHTML = '';
}

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
    /** @type {Candidate[]} */
    queue: [],
    /** @type {Candidate | null} */
    current: null,
    detachSwipe: null,
    authed: null,
    showSearch: false,
    // 'artist' (search the roster of artists to swipe on/view) or 'track'
    // (issue #108: "I often try to find and like a track and I'm unable
    // to" -- the deck's search had no way to look up a specific song at
    // all, only artists by name). Always resets to 'artist' on close/reopen
    // -- unlike searchQuery/searchResults, this never needs to survive the
    // /artist?id=... round trip via search.js's saveSearchState, since
    // selectTrack() never navigates away in the first place.
    searchType: 'artist',
    searchQuery: '',
    searchResults: [],
    searching: false,
    // Guards selectTrack()'s catalog-then-swipe round trip against a
    // double-tap firing it twice.
    likingTrack: false,
    debouncedSearch: null,
    matchModal: null,
    // Set to a genre name once the swipe response reports that genre's pass
    // count just crossed the threshold (src/routes/musicSwipes.ts); null
    // the rest of the time.
    genrePrompt: null,
    // { text, answered } once loaded, or null while loading/on failure --
    // the deck's only discovery surface for /drop (public/drop.html), so a
    // failure here just means no banner, never a broken deck.
    dailyDropPrompt: null,

    // Bumped every time playerBar.js reports the active track changed (a tap
    // here, elsewhere, or radio auto-advancing) -- referenced inside both
    // methods below purely to give Alpine an actual reactive dependency to
    // re-run them on, since isCurrentTrack() itself reads playerBar.js's own
    // module state rather than anything on this component. Same "value
    // doesn't matter, only that it changed" idiom as messages.js/group.js's
    // `now = Date.now()` re-evaluating canRecall().
    nowPlayingTick: 0,
    unsubscribeNowPlaying: null,

    // Reads playerBar.js's own module state rather than keeping a local
    // copy -- true exactly when the current card's anthem is the track
    // actually playing in the fixed bar.
    isCurrentAnthem() {
      void this.nowPlayingTick;
      return !!this.current?.anthemTrack && isCurrentTrack(this.current.anthemTrack.spotifyId);
    },

    async init() {
      recordSessionStartOnce();
      this.unsubscribeNowPlaying = onNowPlayingChange(() => {
        this.nowPlayingTick++;
      });
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
        this.loadDailyDropPrompt();
      }
      this.debouncedSearch = debounce(() => this.runSearch(), 300);
    },

    // Fire-and-forget, same reasoning as showNext()'s artist-profile
    // prefetch below -- a failure here just means no banner, never a
    // broken deck.
    async loadDailyDropPrompt() {
      try {
        const res = await api.dailyDrop();
        this.dailyDropPrompt = { text: res.prompt.text, answered: !!res.myAnswer };
      } catch (e) {
        // Non-fatal.
      }
    },

    destroy() {
      if (this.detachSwipe) {
        this.detachSwipe();
        this.detachSwipe = null;
      }
      this.unsubscribeNowPlaying?.();
      this.unsubscribeNowPlaying = null;
      // issue #159/#160: leaving the page entirely is exactly the same
      // "no longer showing this card" case showNext() already handles per
      // swipe -- without this, navigating away mid-play would leave the
      // embed's iframe mounted and playing in a torn-down page.
      hideCardPreviewEmbed();
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
          this.detachSwipe = attachSwipeDeck(card, {
            onSwipe: (dir) => this.decide(dir),
            // issue #145 (Round 7): a tap anywhere on the card (not just the
            // name button, which still works via its own click handler and
            // never reaches here since it stops the pointerdown that would
            // otherwise start a drag) opens the same artist/profile view.
            onTap: () => (this.mode === 'music' ? this.viewArtist() : this.viewProfile()),
          });
        }
        // issue #159/#160: swap in the new card's own representative-track
        // embed (or tear down the previous one) every time the current
        // candidate changes -- covers advancing via a swipe, a fresh
        // loadQueue() on init, and a mode switch away from Music (current
        // still exists in People mode, just never carries `track`).
        if (this.mode === 'music' && this.current?.track) {
          showCardPreviewEmbed(this.current.track.spotifyId);
        } else {
          hideCardPreviewEmbed();
        }
      });
      preloadCandidateImage(this.queue[0], this.mode);

      // Music mode only: GET /api/artists/:id can be slow for a
      // not-yet-fully-cataloged artist (src/routes/catalog.ts's
      // quick-fetch/backfill path, itself a live Spotify round-trip).
      // Firing it here, for the item about to become `current` on the NEXT
      // swipe, means its DB-first check (or worst case its Spotify
      // quick-fetch) has already happened well before the user actually
      // taps into it -- whether via the clickable artist name below or by
      // swiping again and tapping there. Every card except the very first
      // of a session ends up warmed this way, since each one sits as
      // queue[0] for one full swipe before becoming `current` itself.
      // Fire-and-forget: a failure here has no visible effect, since the
      // real navigation re-requests this same endpoint anyway and handles
      // its own errors.
      if (this.mode === 'music' && this.queue[0]) {
        api.artistProfile(this.queue[0].itemId).catch(() => {});
      }
    },

    viewArtist() {
      if (!this.current || this.mode !== 'music') return;
      navigate(`/artist?id=${this.current.itemId}`);
    },

    async decide(direction) {
      if (!this.current) return;
      const swiped = this.current;
      try {
        if (this.mode === 'people') {
          const res = await api.swipe('people', { target_id: swiped.id, direction });
          // Issue #170: fire-and-forget, same as every other recordEvent call
          // in this file -- a dropped analytics write must never block or
          // fail the swipe itself.
          api.recordEvent('people_swipe', { direction }).catch(() => {});
          if (res.matched) {
            api.recordEvent('match_created', { matchId: res.matchId }).catch(() => {});
            // Hold on the celebration instead of immediately advancing --
            // dismissMatch() (or the deck's own showNext/loadQueue logic)
            // moves to the next candidate once the user is ready.
            this.matchModal = { name: swiped.displayName, photoUrl: swiped.primaryPhotoUrl, matchId: res.matchId };
            return;
          }
        } else {
          const res = await api.swipe('music', { item_type: swiped.itemType, item_id: swiped.itemId, direction });
          api.recordEvent('music_swipe', { direction }).catch(() => {});
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
      // issue #127 item 7: the keyboard still didn't reliably open on the
      // first tap even with focusAfterReveal's nextTick+rAF fix (issue
      // #108) in place -- revealAndFocusSync closes the gap by reveal +
      // focus synchronously, no ticks between this click and either call.
      // See domUtils.js's own comment for the full reasoning.
      revealAndFocusSync(this.$refs.searchOverlay, this.$refs.searchInput);
    },

    closeSearch() {
      this.showSearch = false;
      this.searchType = 'artist';
      this.searchQuery = '';
      this.searchResults = [];
    },

    // Switches between searching artists and songs without requiring the
    // query to be retyped -- re-runs immediately against whatever's already
    // typed, same as how onSearchInput() itself behaves.
    setSearchType(type) {
      if (this.searchType === type) return;
      this.searchType = type;
      this.searchResults = [];
      if (shouldSearch(this.searchQuery)) this.runSearch();
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
        const q = this.searchQuery.trim();
        const res = this.searchType === 'track' ? await api.trackSearch(q) : await api.artistSearch(q);
        this.searchResults = res.results;
      } catch (e) {
        showErrorToast('Could not search right now. Please try again.');
      } finally {
        this.searching = false;
      }
    },

    async selectArtist(result) {
      // Saved right before leaving the deck's search view -- even though
      // this now goes through the router (a real reload isn't needed to
      // reopen this same search on the way back), init()'s own
      // takeSearchState call still only runs once per fresh createDeckApp()
      // instance, which is exactly what a route back to `/` produces
      // (whether from the browser's back button or another tap into
      // search) -- see search.js's own comment on why this landed the user
      // somewhere unhelpful (defaulting back to People mode, with no memory
      // of what they'd searched) before this existed.
      saveSearchState(sessionStorage, { query: this.searchQuery, results: this.searchResults });

      // Already cataloged -- result.id is our internal artist UUID.
      if (result.inCatalog) {
        await navigate(`/artist?id=${result.id}`);
        return;
      }
      // A live Spotify result has no internal id yet (see GET
      // /api/artists/search's `inCatalog: false` shape) -- persist it first
      // so there's a real artist row (and UUID) to navigate to.
      try {
        const res = await api.createArtist(result.spotifyArtistId);
        await navigate(`/artist?id=${res.artistId}`);
      } catch (e) {
        showErrorToast('Could not add that artist. Please try again.');
      }
    },

    // Tapping a song result likes it directly (POST /api/swipe/music,
    // item_type: 'track') rather than navigating anywhere -- this is a
    // one-step "find and like a song" tool (issue #108), not an alternate
    // way into an artist's page. Liking through the catalog rather than a
    // raw Spotify id is deliberate, not incidental: it's what makes the
    // like cascade to an artist-level like/genre-affinity bump
    // (likeArtistForTrack, src/routes/musicSwipes.ts) and real-time Spotify
    // follow-sync, the same as every other like in this app -- a bare
    // Spotify-sourced item_id would swipe successfully but silently skip
    // all of that.
    async selectTrack(result) {
      if (this.likingTrack) return;
      this.likingTrack = true;
      try {
        let trackId = result.id;
        if (!trackId) {
          // Not yet cataloged (GET /api/tracks/search's `inCatalog: false`
          // shape) -- ensure the artist exists first (POST /api/artists is
          // DB-first/idempotent, same as selectArtist() above, so this is
          // cheap even if the artist's already cataloged from some other
          // path), then the track itself, to get a real internal id to
          // swipe against.
          const artistRes = await api.createArtist(result.spotifyArtistId);
          const trackRes = await api.createTrack(result.spotifyTrackId, artistRes.artistId);
          trackId = trackRes.trackId;
        }
        await api.swipe('music', { item_type: 'track', item_id: trackId, direction: 'right' });
        // Issue #170: same event as the deck's own swipe (decide()), tagged
        // with its source since this is the one-step search "quick like"
        // path (issue #108), not a deck card.
        api.recordEvent('music_swipe', { direction: 'right', source: 'search' }).catch(() => {});
        showToast({ message: `Liked "${result.name}"`, icon: '❤️' });
        this.closeSearch();
      } catch (e) {
        showErrorToast('Could not like that song. Please try again.');
      } finally {
        this.likingTrack = false;
      }
    },

    viewProfile() {
      if (!this.current) return;
      navigate(`/profile?id=${this.current.id}`);
    },

    async toggleAnthem() {
      if (!this.current?.anthemTrack) return;
      if (this.isCurrentAnthem()) {
        await togglePlayPause();
        return;
      }
      // An anthem's `id` equals its `spotifyId` (this data is straight from
      // Spotify's own "top tracks" for the card's owner, never touching the
      // tracks catalog table) -- the player bar's like button still works
      // fine against it (POST /api/swipe/music has no FK constraint on
      // item_id), it just won't cascade to an artist-like/genre-affinity
      // bump the way a catalog-backed track's like does.
      const { spotifyId, id, name, artistName, imageUrl } = this.current.anthemTrack;
      await play({ spotifyId, id, name, artistName, imageUrl });
      // Issue #161: a fresh play (not a resume via togglePlayPause above) --
      // fire-and-forget, same reasoning as recordSessionStartOnce.
      api.recordEvent('song_play', { trackId: id }).catch(() => {});
    },
  };
}
