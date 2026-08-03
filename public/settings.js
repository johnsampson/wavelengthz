import { api } from './app.js';

// Extracted from settings.html's inline script so the round-tripping logic
// below is directly testable (same pattern as swipe.js). The page just does
// `window.settingsApp = createSettingsApp`.
//
// Settings deliberately reuses POST /api/onboarding rather than introducing a
// separate PATCH /api/me. That endpoint does an unconditional `SET bio = ?`,
// so every field it owns has to be echoed back or it gets clobbered -- hence
// the fetch-then-resubmit-with-existing-values shape of both init() and
// updateDistance().
export function createSettingsApp() {
  return {
    maxDistanceKm: 80,
    bio: null,
    confirmingDelete: false,
    error: null,
    saved: false,
    loading: true,

    async init() {
      try {
        const me = await api.me();
        // Never leave the slider on a hardcoded default: saving would then
        // silently overwrite the user's real radius with 80.
        if (me.user.max_distance_km != null) this.maxDistanceKm = me.user.max_distance_km;
        this.bio = me.user.bio ?? null;
      } catch (e) {
        this.error = 'Could not load your settings. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    async updateDistance() {
      this.error = null;
      this.saved = false;
      try {
        const me = await api.me();
        await api.onboard({
          // bio is re-sent because /api/onboarding unconditionally writes it;
          // omitting it wipes the user's bio to NULL on every settings save.
          bio: me.user.bio ?? null,
          date_of_birth: me.user.date_of_birth,
          location_label: me.user.location_label,
          lat: me.user.lat,
          lng: me.user.lng,
          max_distance_km: this.maxDistanceKm,
        });
        this.bio = me.user.bio ?? null;
        this.saved = true;
      } catch (e) {
        this.error = 'Could not save your settings. Please try again.';
      }
    },

    async logout() {
      this.error = null;
      try {
        await fetch('/logout', { method: 'POST', credentials: 'include' });
        window.location.href = '/login';
      } catch (e) {
        this.error = 'Could not log out. Please try again.';
      }
    },

    async deleteAccount() {
      this.error = null;
      try {
        await api.deleteAccount();
        window.location.href = '/';
      } catch (e) {
        this.error = 'Could not delete your account. Please try again.';
      }
    },
  };
}
