// Bumped v2 -> v3 -> v4 -> v5 -> v6 -> v7 -> v8 -> v9 -> v10: v3/v4 fixed the
// CSP/connect-src issue (see below). v5 added /groups and /group to the
// precache list. v6 added the Spotify embed iframe to /artist (replacing
// the dead-preview <audio> player). v7 fixed that iframe being x-show'd
// (hidden, but still mounted and playing) instead of x-if'd (actually
// removed from the DOM). v8 makes /history's people/artist names clickable
// links back to their profile/artist page. v9: artists/tracks ids are now
// obfuscated internal UUIDs (migrations/0002_obfuscate_catalog_ids.sql) --
// /artist's embed iframe now reads track.spotifyId instead of track.id, so
// a stale cached copy would build a broken (UUID-based) embed URL. v10
// fixes selecting a not-yet-cataloged artist from Music-mode search --
// selectArtist() now POSTs it to /api/artists first instead of navigating
// straight to /artist?id=undefined. v11 adds 3s polling to /messages so new
// messages show up without a manual refresh, plus a synthesized sound and
// navigator.vibrate() when one arrives from the other person. v13 adds the
// same Spotify embed player to /profile's three track lists (top/shared/
// recent), matching /artist. v14 fixes /group's message list missing
// w-full, which let it shrink-wrap instead of matching the header/input's
// width -- messages appeared adrift in the middle of the page instead of
// filling the same column. v15 adds the same 3s polling + sound/vibrate
// notification to /group that /messages already had -- it was never
// actually ported over to group chat. v16 adds message recall (15s window)
// to both /messages and /group, and fixes /messages' client-side charset
// pre-check missing a hyphen (it disagreed with the server's regex and with
// /group's own pre-check). v17 fixes recall not showing up for the other
// participant's poll -- it only refreshed on a message-count change, and a
// recall doesn't change the count, just flips recalledAt on an existing row.
// v18 replaces /profile's photo grid with a single-image carousel (prev/next
// arrows + a shared index with the full-screen lightbox). v19 adds a Report
// button to /profile -- previously the only report entry point anywhere in
// the app was from an active match (match.html), with no way to report
// someone from their photos/bio before ever matching. v20 adds push
// notification handling (push + notificationclick listeners) -- see
// docs/superpowers/plans/2026-08-09-web-push-notifications.md. v21 fixes
// notificationclick's existing-tab match: message pushes now deep-link with
// a matchId query string, so comparing only pathname (the old check) wrongly
// treated any open /messages tab as "the same" conversation regardless of
// which match it was actually showing. v22 points push notifications' icon
// at the hosted app logo instead of the local placeholder /icons/icon-192.png.
// v23 splits /settings into four sub-pages (/settings/profile,
// /settings/preferences, /settings/notifications, /settings/connections) --
// without a cache bump, this SW's cache-first fetch handler would keep every
// already-installed user on the old pre-split /settings and /settings.js
// forever, since nothing in the fetch handler ever revalidates. v24 covers a
// batch of 7 PRs merged without bumping this, so every one of them was
// silently stuck behind the cache-first fetch handler until now: adds a Bio
// field to /settings/profile.js, locks gender read-only on
// /settings/preferences.js, adds the email-notifications toggle to
// /settings/notifications.js, makes /profile's artist chips link out,
// reorders / rewords the deck (index.html) header/empty-state and adds the
// skip button, and splits /history.js's Music tab into Artists/Tracks.
// v25 adds the new /settings/messaging sub-page (bio/photos/liked-songs/
// phone-verification checklist for unlocking messaging, issue #36 item 1
// expanded) -- a brand new precached route + its script, not just an edit
// to an existing one, so it has to be in APP_SHELL from the start or a
// first-time offline visit to it 404s. v26 fixes /artist showing the same
// opaque "Could not load this artist" for a Spotify-rate-limit failure as
// every other error -- it now shows a specific "Spotify's a little busy"
// message for that case (src/index.ts's new SpotifyRateLimitError -> 503
// translation). v27 replaces nearly every page's scroll-prone inline
// "<p x-show=error>" action-failure banner with a growl toast
// (public/toast.js's new error variant) -- touches most precached HTML/JS
// files in this list (index, artist, match, messages, group, groups,
// profile, onboarding, history.js, settings.js, and every settings/*.js
// sub-page). v28 fixes /onboarding and /settings/profile's display-name
// `pattern` attribute -- Chrome now compiles <input pattern> as a `v`-flag
// (unicodeSets) regex, which requires escaping `-` inside a character class
// even at the leading/trailing edge, unlike classic regex; the unescaped
// version threw "Invalid regular expression" in the console on every save.
// v29 self-hosts Alpine.js (public/alpine.js, vendored from the alpinejs npm
// package via `npm run vendor:alpine`) instead of loading it from the
// cdn.jsdelivr.net CDN on every one of the 17 pages that use it -- that CDN
// request was un-cacheable by this SW (cross-origin requests are left to the
// browser's normal fetch, see the fetch handler below) and render-blocking,
// so even an install with the rest of the shell served instantly from cache
// still had to wait on a live network round-trip before Alpine's x-init
// directives ran and the page became interactive. CSP's script-src no longer
// allow-lists cdn.jsdelivr.net (src/index.ts and public/_headers) since
// 'self' now covers it. v30 fixes the deck (/) and /history always
// defaulting to People mode on every fresh load, no matter which mode was
// last selected -- switching to Music mode never stuck across a page
// reload or the browser's back button. Also makes returning from an
// artist's page (tapped from a deck search result) reopen that same
// search instead of landing on a bare, closed deck (search.js's new
// saveSearchState/takeSearchState, wired into index.html). v31 replaces the
// 5 duplicated inline "Wavelengthz Player vs. Basic player" blocks on /,
// /artist, and /profile with one shared fixed player bar above the bottom
// nav (public/playerBar.js, new -- added to this precache list) -- also
// touches index.html/artist.html/profile.html's own markup/scripts and
// every other precached page's bottom padding (pb-24/mb-20 -> the new
// .pb-app/.mb-app utility classes in tailwind.css, which react to whether
// the bar is currently showing). v32 adds public/router.js: internal link
// clicks between any two of the 16 non-onboarding routes now swap
// #wl-app-root's content in place instead of doing a full page reload, so
// the player bar (and everything else outside #wl-app-root) survives
// navigating around the app -- the actual "keeps playing" behavior the
// fixed bar was originally built for. Every page's inline Alpine app moved
// off <body> onto <div id="wl-app-root"> and was extracted to its own
// module (index.js, artist.js, personProfile.js, matches.js, match.js,
// groups.js, notifications.js, messages.js, group.js -- all new, all added
// to this precache list, alongside router.js itself); messages.js/group.js
// additionally gained a destroy() that clears their 3s poll interval and
// audio-unlock listeners, a leak that was harmless under the old
// full-reload-per-navigation model but wouldn't have been under this one
// without it. Also fixes two long-standing gaps in this precache list
// itself -- /toast.js (used by nearly every page, never precached) and
// /wavelengthzPlayer.js (already fixed in v31, kept here since this list
// needed a full pass anyway) -- and a genuine bug on /profile: the photo
// lightbox's prev/next buttons read profile.photoUrls outside the x-if=
// "profile" guard the rest of the page uses, throwing "Cannot read
// properties of null" in the console on every load before the profile
// fetch resolved (Alpine's x-show evaluates its expression continuously
// regardless of visibility, unlike x-if). /onboarding is deliberately not
// on the router (see router.js's ROUTES) -- it's a one-time gate reached by
// redirect, not a destination anyone links to or navigates back into. v33
// is a round of player-bar feedback: taller chrome with the artist name
// shown alongside the track, a marquee that auto-scrolls a truncated
// name/artist instead of just clipping it, a neutral loading state instead
// of a "Basic player" badge flash before Premium availability resolves, a
// like button (POST /api/swipe/music, mirrored from every track row's own
// Like button), and --wl-nav-h is now measured from the real rendered nav
// (nav.js's mountNav) instead of a hardcoded estimate -- fixes a 1-2px gap
// between the player bar and the nav that let scrolled content peek
// through. Also routes several more internal navigations (deck search ->
// artist/profile, groups -> group, match unmatch/block -> matches, group
// leave -> groups) through the client-side router instead of a hard
// window.location.href reload, so playback survives them the same way it
// already did for a plain link click -- and replaces the deck/artist pages'
// swipe-left "Pass" ✕ icon with a thumbs-down glyph. v34 adds
// <link rel="manifest" href="/manifest.json"> to every page's <head> --
// previously only index.html and login.html had it, so "Add to Home
// Screen" from any other page (e.g. /settings) had no manifest to read
// start_url from and just bookmarked whatever page was currently open
// instead of installing a real app shortcut back to the deck. Anyone who
// already installed from a non-deck page needs to remove that shortcut and
// re-add it (a code fix alone can't retroactively repoint an icon that
// already exists on a home screen). v35 adds <link rel="apple-touch-icon">
// and <meta name="apple-mobile-web-app-capable"> to every page's <head> --
// iOS Safari's "Add to Home Screen" reads apple-touch-icon directly
// (independent of the web app manifest), and had nothing to read anywhere
// in this app before now, which is why the app logo never showed up on an
// iPhone home screen. Also switches manifest.json's icons and the new
// apple-touch-icon links from the external img.wavelengthz.com CDN to new
// local files under public/icons/ (added to this precache list below) --
// self-hosted, so an icon is available offline on first install instead of
// depending on a live cross-origin fetch. Placeholder source image for now
// (still has a transparent background, so iOS pre-16 will still fill it
// white/black at the corners depending on system theme) -- swapping in a
// proper opaque-background version later still needs its own CACHE_NAME
// bump like any other precached file's content changing, same as
// everywhere else in this list. v36 makes the Music-mode deck card's
// artist name clickable (routes to /artist?id=..., matching the "view full
// profile" affordance People mode already had) and adds a "play a song"
// chip below it when the artist already has a track in the catalog
// (GET /api/candidates/music now batches one representative track per
// artist candidate alongside the rest of the row, instead of a separate
// per-card fetch). Also fires a background GET /api/artists/:id for the
// next queued candidate on every showNext() in Music mode, so a
// not-yet-fully-cataloged artist's slow first-load path (src/routes/
// catalog.ts's quick-fetch/backfill, itself a live Spotify round-trip) has
// already run by the time the user actually taps into it -- every card
// except the first of a session ends up warmed this way. Also adds a
// direct "like this artist" button to /artist's header (previously the
// only way to like an artist was indirectly, via the deck or liking one of
// its tracks). v37 fixes the bottom nav (and player bar) visibly sliding
// up with the page during a swipe on mobile, leaving a gap of bare
// background below them -- every page's <body> switches from min-h-screen
// (100vh, a static value that doesn't track the browser's dynamic
// toolbar hiding/showing on scroll) to min-h-dvh (100dvh, which does), and
// styles.css adds overscroll-behavior-y: none on html/body to stop the
// elastic overscroll/rubber-band bounce itself from dragging fixed-position
// elements along with it in the first place. v38 is a follow-up to v37:
// that fix only covered a page with no genuinely scrollable content --
// on a page long enough to actually scroll, the nav/player bar could still
// visibly lag behind mid-scroll, a distinct iOS Safari quirk where a plain
// `position: fixed` element isn't always kept perfectly glued to the
// visual viewport while the browser's toolbar is animating in/out during a
// real scroll gesture. Adds a new .wl-gpu-layer class (styles.css) --
// translateZ(0) + backface-visibility: hidden, the standard fix that
// forces the element onto its own GPU compositing layer so the compositor
// (which drives the toolbar animation) positions it directly, instead of
// lagging behind a main-thread position update -- applied to nav.js's own
// <nav> (renderNavHtml) and every page's #wl-player-root. v39 makes
// sharing a song a
// first-class message type in both 1:1 match threads and group threads
// (migrations/0021 adds messages.track_id / group_messages.track_id):
// messages.html/group.html gain a song picker (public/trackPicker.js, new --
// added to this precache list below, and shared by messages.js and group.js
// rather than duplicated), a one-tap "send what I'm playing right now"
// option, in-thread track bubbles that play through the persistent player
// bar, and a shared-playlist panel derived from every non-recalled track
// message in the thread. Also adds an unscoped one-step song search
// (GET /api/tracks/search with no artist_id) -- previously finding a song
// required picking its artist first, which is far too much friction for
// something sent mid-conversation. v40 fixes two things v39 shipped
// broken. (1) The chat threads never actually scrolled: <body> was
// min-h-dvh (a floor, not a height), so the flex column grew to fit every
// message and the message list's own overflow-y-auto never engaged --
// scrollToBottom() was setting scrollTop on an element that wasn't a scroll
// container, so a newly-sent message landed below the fold. Both threads are
// now h-dvh + overflow-hidden with a min-h-0 list, and scrollToBottom()
// re-pins once each not-yet-loaded album image settles (a shared track's art
// has no intrinsic height until it loads, which was landing the scroll
// short). (2) The fetch handler now passes ignoreSearch for navigation
// requests -- see its own comment: every precached route that takes a query
// string (/messages?matchId=, /match?id=, /artist?id=, /profile?id=,
// /group?id=) was missing the cache for its HTML while still serving that
// page's .js FROM the cache, so a release that changed both left an
// installed PWA running new markup against a stale script. router.js's
// import() also fails soft now instead of rejecting unhandled. v41 gives artists a
// better shot at a counted stream, and makes the current rate visible.
// Spotify pays a rightsholder once a track has been played 30 seconds, and
// a swipe-shaped app has an obvious structural reason to rarely get there.
// The Wavelengthz Player now starts a track partway in (public/
// playHeuristics.js's hookOffsetMs -- new, added to this precache list)
// rather than at 0:00, so the first 30 seconds is the hook rather than the
// intro; Spotify counts 30s of playback wherever it started, so this changes
// how long people stay, not whether a play counts. It also records each SDK
// play and whether accumulated PLAYING time (not track position -- see
// playHeuristics' createPlayProgress) crossed the threshold, via the new
// POST /api/plays endpoints, so the counted share stops being invisible.
// Nothing here touches the Free-tier iframe path, which exposes no JS API
// and is therefore unobservable and uninfluenceable. v42 adds radio: when
// a track
// finishes on its own, the player rolls into the next track by the same
// artist instead of falling silent. Universal -- wherever playback was
// started from, it continues the same way. Deliberately NOT autoplay:
// arriving anywhere in the app (the deck especially) still starts nothing,
// and only an explicit tap changes what's playing; radio purely continues
// something the listener already chose. The queue comes from one D1-only
// call (GET /api/tracks/:id/radio, zero Spotify), fetched once when playback
// starts and advanced through client-side. Track endings are detected via
// playHeuristics' isTrackEnd, since the Web Playback SDK has no
// end-of-track event -- and consecutive auto-advances are capped
// (RADIO_MAX_CONSECUTIVE) so a forgotten tab can't play on indefinitely.
// v43 adds opt-in Spotify playlist sync to /settings/connections: liked songs
// can now be exported to a private "Wavelengthz" playlist in the user's own
// Spotify account. Enabling it is a separate, explicit consent trip
// (/login/spotify?intent=sync) rather than part of sign-in -- the write scope
// it needs cannot be added to an existing token, and asking for write access
// on the first consent screen is the wrong trade. connections.html/.js and
// app.js all changed, and all three are precached.
// v44 fixes radio never advancing in a real session. v42's end-of-track
// detection waited for the SDK to emit paused-at-position-0, but
// player_state_changed fires on transitions, not on a clock -- and when a
// single-uri context runs out the SDK commonly emits a null state ("device no
// longer active") instead, which the listener discarded before any heuristic
// saw it. End-of-track is now driven primarily by a timer for the track's own
// remaining time (the same approach the 30-second threshold already used, for
// the same reason), with the null state and the original paused-at-0
// heuristic as backups. playerBar.js and playHeuristics.js both changed and
// both are precached.
// v45 makes the player's progress bar seekable -- tap or drag anywhere on it
// to jump to that point in the song, with arrow-key support so it isn't
// pointer-only. The bar keeps its 4px look but gets a ~20px touch target.
// Seeking deliberately doesn't touch threshold accounting, which measures
// playing time rather than position, so scrubbing can't fast-track a counted
// play. playerBar.js and wavelengthzPlayer.js changed; both are precached.
// v46 adds member face icons to groups (issue #2): the /groups cards show an
// overlapping stack of member photos beside the member count, and /group's
// header shows the same for its own members. Photos come from the existing
// position-0 + moderation-approved rule, now shared via src/lib/photos.ts.
// groups.html and group.html both changed and both are precached.
// v47 puts a total on History (issue #2): each tab now shows how many
// people/artists/songs match the current tab and direction filter, counted
// server-side under the same filters as the page. Paging also became exact
// rather than inferred -- the old "a full page means there's more" heuristic
// offered a Next page whenever the total was an exact multiple of the page
// size, landing on an empty list. history.html and history.js both changed
// and both are precached.
// v48 adds opt-in following of liked artists to /settings/connections, the
// second Spotify write destination after v43's playlist sync. Its own scope,
// its own consent trip (/login/spotify?intent=follow) and its own toggle --
// a follow is outward-facing (it shows on the user's Spotify profile and
// feeds Release Radar) where the playlist is private, so consenting to one
// must never imply the other. connections.html/.js and app.js all changed
// and all three are precached.
// v49 adds /wavelength: a monthly view of how the user's taste has shifted,
// computed from music_swipes' own timestamps (user_genres holds running
// totals with no history, so it can say what someone likes but never what
// changed). Brand-new route and script, so both MUST be in APP_SHELL from
// this version or a first visit 404s offline. Says nothing at all below a
// noise floor rather than reporting a trend from two swipes.
// v50 fixes issue #108's "search bar focus dies not open keyboard without a
// 2nd click" on iOS Safari, in both the deck's artist search (index.js) and
// the track-share picker (trackPicker.js) -- new public/domUtils.js's
// focusAfterReveal() replaces a bare $nextTick(() => ...focus()) with
// $nextTick + requestAnimationFrame, which keeps the focus() call inside the
// browser's gesture-linked paint pipeline instead of a microtask iOS drops
// the gesture link across. trackPicker.js's picker also now focuses BEFORE
// its now-playing fetch rather than after -- an await loses the tap gesture
// entirely, so focusing afterward could never have worked on iOS regardless
// of scheduling. domUtils.js is new and precached.
// v51 fixes issue #108's "the thumb down icon is not right on track card":
// artist.html's per-track Pass button rendered its thumbs-down SVG a size
// smaller (h-4 w-4) than its sibling Play button (h-5 w-5) in the same h-9
// w-9 circle -- the glyph itself was already correct (the same Feather
// thumbs-down path the deck's own Pass button uses), just undersized. Also
// replaces the per-track and per-artist Like buttons' raw "♥" text glyph
// with the same heart SVG path the player bar and deck use, per the issue's
// "align... same like/heart, etc." ask.
// v52 clarifies that photos are genuinely optional at onboarding (issue
// #108: "don't require photos on onboarding"). Nothing in onboarding.html's
// submit() or POST /api/onboarding was ever actually gated on photo count --
// the count next to a file-upload control right before Continue just read as
// mandatory with nothing saying otherwise. Now explicitly labeled optional,
// with a note that messaging (messagingGate.ts's MIN_PHOTOS) does need a few
// eventually, said here so that isn't a surprise met for the first time deep
// in Settings after onboarding is already done.
// v53 guards the two person-photo <img>s that could render with a null src
// (issue #108's "only show a photo if one exists"): the People-mode deck
// card's primaryPhotoUrl and the match-modal's photoUrl, both null for a
// candidate with no uploaded photos -- now genuinely possible for anyone who
// skipped photos at onboarding (v52's change made that explicit). Each is
// now wrapped in x-if, matching the guard group.html already uses for
// member face icons, rather than always rendering an <img> with a dropped
// src attribute.
// v54 adds a swipe-left-to-reveal-trash gesture to the player bar
// (public/playerBar.js) for closing it, alongside the existing explicit X
// button (issue #108: "align the radio player w/ the tracks view... maybe
// make the radio a swipe left that exposes a trash can to close the
// radio?"). No new precached files, but playerBar.js's content changed.
// v55 fixes "wrong logo on Add to Home Screen": public/icons/icon-{180,192,
// 512}.png (added in v35) carried real alpha transparency -- the corners
// AND the crown/heart mark itself were literally cutouts, not solid pixels
// (confirmed by inspecting the alpha channel directly), which is exactly
// what v35's own commit flagged as a placeholder needing a follow-up
// ("iOS pre-16 will still fill the transparent regions white/black
// depending on system theme... a proper opaque-background version is
// expected to replace these files later"). Apple's guidance is explicit:
// home-screen icons must carry no alpha channel at all. Reconstructed all
// three as flat opaque PNGs (brand pink square, solid white mark, using the
// original alpha channel purely as a stencil for where each color goes) --
// same visual design, just actually opaque now. No new precached files,
// but their content changed.
// v56 fixes issue #108's "on a slower connection after you slid the artist
// to the left the artist picture reappears for a brief second before the
// next artist picture shows" -- swipe.js's attachSwipeDeck reuses the same
// <img> element across cards, so a not-yet-loaded next image left the
// PREVIOUS candidate's photo visibly showing until it finished downloading.
// index.js's showNext() now preloads the upcoming candidate's image while
// it still has a full swipe's worth of dwell time as queue[0], same
// reasoning as the existing artist-profile prefetch just below it in that
// function. No new precached files, but index.js's content changed.
// v57 adds a Songs tab to the deck's search modal (issue #108: "I often try
// to find and like a track and I'm unable to" -- search only ever looked up
// artists by name, with no way to find a specific song at all). Tapping a
// song result likes it directly (POST /api/swipe/music) rather than
// navigating anywhere, cataloging the artist/track first if either isn't
// already in D1 (GET /api/tracks/search's unscoped form now also reports
// spotifyArtistId for exactly this). No new precached files, but
// app.js/index.html/index.js's content changed.
// v58 adds public/tapFeedback.js, wired into every page's bootstrap script:
// this app already defines active:scale-*/active:bg-* Tailwind states on
// nearly everything tappable (btn-primary/btn-secondary/btn-ghost/
// btn-danger, pill-toggle, nav.js's tab bar), but iOS Safari never applies
// :active on a plain tap unless some touch listener is registered
// somewhere on the page -- a long-documented WebKit quirk nothing in this
// app ever worked around, so none of those already-authored states had ever
// actually fired on iOS. One no-op touchstart listener fixes all of them at
// once. Also fires a short (10ms) haptic buzz via the Vibration API on a
// real button tap -- a no-op on iOS (Safari has never implemented the
// Vibration API at all, so this is real feedback only on Android). New
// precached file, so it must be in APP_SHELL from this version or an
// already-installed user's next visit 404s on the import.
// v59 widens wavelengthzPlayer.js's SDK connect-handshake timeout (8s ->
// 15s) -- a paid (Premium) account on a slow-but-working connection was
// permanently downgrading to the read-only iframe for the whole page load
// because the handshake genuinely needed more than 8s, not because
// anything was actually broken. No new precached files, but
// wavelengthzPlayer.js's content changed.
// v60 adds The Daily Drop (docs/superpowers/specs/2026-08-17-idea-daily-drop.md):
// one prompt a day, answered with a song, browsable against everyone else's
// answer to the same prompt -- this app's own retention-strategy work's #1
// ranked idea, aimed at the gap that every notification today is purely
// reactive (a match or message someone else triggers) with no self-serve
// reason to open the app. New /drop route + drop.js (both added to this
// precache list), a banner on the deck (index.html/index.js) as its only
// discovery surface, and 3 new app.js client methods. Browse-only in v1 --
// deliberately not a scoring/matching input yet, see the spec doc.
// v61 adds the gender-balanced invite system (docs/superpowers/specs/
// 2026-08-09-gender-balanced-invite-gate-design.md): every completed
// onboarding hands out 2 codes that only work for the opposite gender --
// self-balancing growth, off by default (INVITE_ONLY unset). New Settings ->
// "Your invites" panel (/settings/invites + its .js, both added to this
// precache list); /join and /join/continue are the pre-auth redemption
// landing page, deliberately NOT precached, same treatment as /login. New
// app.js client method (myInvites), settings.html links to the new panel.
// v62 fixes track-card play/pause icons (artist, profile, the deck, /drop,
// message/group threads) going stale when playerBar.js's active track
// changes out from under the page showing them -- most visibly radio
// auto-advancing to the next track while a track-card page just sits there.
// playerBar.js now exposes onNowPlayingChange(); every page/mixin that reads
// isCurrentTrack() subscribes and bumps its own reactive counter so Alpine
// has a dependency to actually re-run those bindings on. Touches
// playerBar.js, artist.js, personProfile.js, index.js, drop.js,
// trackPicker.js, messages.js, and group.js -- all already in this list.
// v63 shows an artist candidate's genres as chips on the deck's Music-mode
// card (GET /api/candidates/music's new topGenres field, capped at 5) --
// index.html's card already had this exact chip row for people-mode's own
// topGenres, just gated to that mode; the gate is dropped so both modes
// share the one markup block.
// v64 fixes /settings' "Account connections", "Your wavelength", and "Your
// invites" links being packed into one shared <li> instead of one each --
// they weren't getting the <ul>'s gap-2 spacing between them the way every
// other row on this page does (issue #127: "fix spacing above 'your
// wavelength' menu item"; also the very likely reason the reporter never
// noticed "Your invites" existed at all, per the next item's fix).
// v65 makes a completed swipe-to-decide gesture vibrate (public/swipe.js),
// same haptic installTapFeedback's click listener already gives a tap on
// the Like/Pass buttons -- swiping to a decision never fired one since a
// drag settles via setTimeout, not a click (issue #127). New
// public/tapFeedback.js export (vibrate()) backs both.
// v66 adds a "Block a genre" search box to Settings -> Preferences (new
// GET /api/genres/search, querying the catalog-wide genres table) -- until
// now the only way a genre ever reached user_blocked_genres was the
// reactive "you've passed 10 artists in GENRE, block it?" prompt, with no
// proactive way to add one (issue #127).
// v67 removes the separate Pass (thumbs-down) button from /artist's track
// rows -- liking is the only action now, one button, circled white when
// liked and unmarked otherwise, same convention likeArtist() already uses
// (issue #127).
const CACHE_NAME = 'wavelengthz-shell-v67';
const APP_SHELL = [
  '/',
  '/app.js',
  '/swipe.js',
  '/settings.js',
  '/nav.js',
  '/auth.js',
  '/history.js',
  '/search.js',
  '/photos.js',
  '/toast.js',
  '/domUtils.js',
  '/tapFeedback.js',
  '/alpine.js',
  '/playerBar.js',
  '/wavelengthzPlayer.js',
  '/router.js',
  '/index.js',
  '/artist.js',
  '/personProfile.js',
  '/matches.js',
  '/match.js',
  '/groups.js',
  '/notifications.js',
  '/messages.js',
  '/group.js',
  '/trackPicker.js',
  '/playHeuristics.js',
  '/tailwind.css',
  '/manifest.json',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/onboarding',
  '/history',
  '/matches',
  '/match',
  '/artist',
  '/profile',
  '/messages',
  '/settings',
  '/settings/profile',
  '/settings/messaging',
  '/settings/preferences',
  '/settings/notifications',
  '/settings/connections',
  '/settings/invites',
  '/settings/profile.js',
  '/settings/messaging.js',
  '/settings/preferences.js',
  '/settings/notifications.js',
  '/settings/connections.js',
  '/settings/invites.js',
  '/wavelength',
  '/wavelength.js',
  '/notifications',
  '/groups',
  '/group',
  '/drop',
  '/drop.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// /login, /callback, and /logout are a third-party OAuth handshake with
// Spotify -- there's nothing to cache, and intercepting them is actively
// harmful: this SW takes control immediately (skipWaiting + clients.claim,
// below), so it can grab the very first navigation on a freshly-registered
// page. Once it does, its fetch() call for /login follows Spotify's 302
// *internally* (fetch()'s default redirect: 'follow') instead of letting the
// browser perform a real top-level navigation -- which silently breaks the
// oauth-state cookie round-trip and produces "Invalid OAuth state" with
// nothing to log server-side, since the request the server sees is entirely
// legitimate, just carrying a cookie from a redirect chain the SW mangled.
const BYPASS_PATHS = new Set(['/login', '/login/spotify', '/login/google', '/callback', '/callback/google', '/logout', '/join', '/join/continue']);

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Cross-origin requests (Google Fonts, the Alpine.js CDN, Spotify's image
  // CDN, ...) are intentionally left to the browser's normal fetch entirely
  // -- letting the SW intercept and re-issue them via fetch() subjects them
  // to the page's connect-src CSP directive regardless of what kind of
  // resource they actually are (script/style/img), which doesn't match
  // reality and isn't this SW's job to cache anyway (third-party CDNs already
  // do their own caching).
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    BYPASS_PATHS.has(url.pathname)
  ) {
    return;
  }

  // ignoreSearch for navigations specifically: caches.match() compares the
  // FULL url including the query string, but almost every real visit to a
  // precached route carries one (/messages?matchId=, /match?id=, /artist?id=,
  // /profile?id=, /group?id=). So those routes were precached and then never
  // actually served from cache -- every visit fell through to the network for
  // its HTML while the SAME page's .js kept being served from cache. That
  // skew is invisible until a release changes both: the browser then runs new
  // markup against a stale script (or the reverse), which is exactly how a
  // freshly-shipped feature can work in a normal browser tab and be broken in
  // an already-installed PWA. It also meant those routes never actually
  // worked offline despite being in APP_SHELL.
  //
  // Scoped to request.mode === 'navigate' -- a document request is the only
  // kind where the query string is a parameter to the same shell rather than
  // part of the resource's identity, so ignoring it anywhere else could serve
  // the wrong asset for a genuinely cache-busted URL.
  const isNavigation = event.request.mode === 'navigate';
  event.respondWith(
    caches
      .match(event.request, isNavigation ? { ignoreSearch: true } : undefined)
      .then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const payload = event.data.json();
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: 'https://img.wavelengthz.com/wavelengthz-logo-transparent.png',
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';
  // targetUrl can now carry a query string (e.g. '/messages?matchId=...'),
  // so an already-open tab only counts as "the same page" when its
  // pathname AND search match -- comparing pathname alone (the old
  // behavior) would treat two different open matches' /messages tabs as
  // interchangeable and focus the wrong conversation.
  const target = new URL(targetUrl, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients.find((c) => {
        const clientUrl = new URL(c.url);
        return clientUrl.pathname === target.pathname && clientUrl.search === target.search;
      });
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
