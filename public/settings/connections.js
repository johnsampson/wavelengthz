import { api } from '../app.js';

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
            this.error = 'That Spotify account is already linked to a different Wavelengthz account.';
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
