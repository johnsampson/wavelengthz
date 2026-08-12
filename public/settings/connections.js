import { api } from '../app.js';
import { showErrorToast } from '../toast.js';

export function createConnectionsApp() {
  return {
    hasSpotify: false,
    spotifyAvatarUrl: null,
    info: null,
    error: null,
    loading: true,

    async init() {
      try {
        const me = await api.me();
        this.spotifyAvatarUrl = me.user.spotify_avatar_url ?? null;
        this.hasSpotify = me.hasSpotify ?? false;

        if (typeof window !== 'undefined') {
          const params = new URLSearchParams(window.location.search);
          if (params.get('spotify_connected') === '1') {
            this.info = 'Spotify connected.';
          } else if (params.get('spotify_error') === 'already_linked') {
            // Reports the outcome of the "Connect Spotify" click that sent
            // the user through the OAuth round-trip a moment ago -- an
            // action result, not "this page failed to load" (the rest of
            // init() below still runs and succeeds), so this growls like
            // any other action-triggered failure rather than sitting in
            // the page's own persistent inline banner.
            showErrorToast('That Spotify account is already linked to a different Wavelengthz account.');
          }
          if (params.has('spotify_connected') || params.has('spotify_error')) {
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
  };
}
