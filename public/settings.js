import { api } from './app.js';

export function createSettingsApp() {
  return {
    userId: null,
    loading: true,
    error: null,

    async init() {
      try {
        const me = await api.me();
        this.userId = me.user.id;
      } catch (e) {
        if (e.status === 401) {
          window.location.href = '/login';
          return;
        }
        this.error = 'Could not load your settings. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    async logout() {
      this.error = null;
      try {
        const res = await fetch('/logout', { method: 'POST', credentials: 'include' });
        if (!res.ok) throw new Error(`Logout failed: ${res.status} ${await res.text()}`);
        // Land on the deck, not /login -- /login immediately kicks off a new
        // Spotify OAuth round-trip, and if Spotify still has an active
        // browser session it re-authenticates the same account with no
        // visible prompt, making a successful logout look like a no-op.
        window.location.href = '/';
      } catch (e) {
        console.error('Logout failed:', e);
        this.error = 'Could not log out. Please try again.';
      }
    },
  };
}
