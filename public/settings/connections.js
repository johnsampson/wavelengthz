import { api } from '../app.js';
import { showErrorToast } from '../toast.js';

export function createConnectionsApp() {
  return {
    hasSpotify: false,
    spotifyAvatarUrl: null,
    info: null,
    error: null,
    loading: true,

    // Playlist sync. `sync` mirrors GET /api/me/playlist-sync exactly; null
    // until loaded so the section can stay hidden rather than flashing a
    // wrong "off" state on first paint. Annotated because a bare `null`
    // initializer infers as type `null`, which makes every later property
    // read an error under checkJs.
    /** @type {{enabled: boolean, connected: boolean, playlistUrl: string | null, lastSyncedAt: number | null, pendingCount: number, syncedCount: number} | null} */
    sync: null,
    syncing: false,

    async init() {
      try {
        const me = await api.me();
        this.spotifyAvatarUrl = me.user.spotify_avatar_url ?? null;
        this.hasSpotify = me.hasSpotify ?? false;

        if (this.hasSpotify) {
          this.sync = await api.playlistSync();
        }

        if (typeof window !== 'undefined') {
          const params = new URLSearchParams(window.location.search);
          if (params.get('spotify_connected') === '1') {
            this.info = 'Spotify connected.';
          } else if (params.get('sync_enabled') === '1') {
            this.info = 'Playlist sync is on. Your liked songs will be added to your Wavelengthz playlist.';
          } else if (params.get('spotify_error') === 'already_linked') {
            // Reports the outcome of the "Connect Spotify" click that sent
            // the user through the OAuth round-trip a moment ago -- an
            // action result, not "this page failed to load" (the rest of
            // init() below still runs and succeeds), so this growls like
            // any other action-triggered failure rather than sitting in
            // the page's own persistent inline banner.
            showErrorToast('That Spotify account is already linked to a different Wavelengthz account.');
          } else if (params.get('sync_error') === 'denied') {
            // Spotify's consent screen was dismissed, or write access was
            // declined there. Nothing was enabled -- say so plainly rather
            // than leaving a toggle that looks on but can never write.
            showErrorToast('Playlist sync needs permission to create a playlist. Nothing was changed.');
          }
          if (params.has('spotify_connected') || params.has('spotify_error') || params.has('sync_enabled') || params.has('sync_error')) {
            window.history.replaceState({}, '', '/settings/connections');
          }
        }
      } catch (e) {
        if (e.status === 401) {
          window.location.href = '/login';
          return;
        }
        this.error = 'Could not load your account connections. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    // Enabling is a full OAuth round trip, not a fetch: the write scope this
    // needs cannot be added to an existing token (see PLAYLIST_SYNC_SCOPE in
    // src/lib/spotify.ts), so there is nothing to POST to -- the callback is
    // what turns sync on, and only if Spotify actually granted it.
    enableSync() {
      window.location.href = '/login/spotify?intent=sync';
    },

    async disableSync() {
      try {
        this.sync = await api.disablePlaylistSync();
        this.info = 'Playlist sync is off. Songs already in your playlist stay there.';
      } catch (e) {
        showErrorToast('Could not turn off playlist sync. Please try again.');
      }
    },

    async syncNow() {
      if (this.syncing) return;
      this.syncing = true;
      try {
        const result = await api.runPlaylistSync();
        this.sync = result.status;

        if (result.needsReconnect) {
          // Spotify revoked our write access from their side. Sync has
          // already been turned off server-side; point at the fix rather
          // than reporting a generic failure.
          showErrorToast('Spotify revoked access for Wavelengthz. Turn playlist sync back on to reconnect.');
        } else if (result.added > 0) {
          this.info = result.hasMore
            ? `Added ${result.added} songs. The rest will follow automatically within the hour.`
            : `Added ${result.added} ${result.added === 1 ? 'song' : 'songs'} to your Wavelengthz playlist.`;
        } else {
          this.info = 'Your playlist is already up to date.';
        }
      } catch (e) {
        showErrorToast('Could not sync your playlist right now. Please try again.');
      } finally {
        this.syncing = false;
      }
    },
  };
}
