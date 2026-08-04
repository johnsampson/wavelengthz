import { api } from './app.js';
import { MAX_PHOTOS, uploadPhotoFile } from './photos.js';

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
    spotifyAvatarUrl: null,
    photos: [],
    maxPhotos: MAX_PHOTOS,
    photoError: null,
    confirmingDelete: false,
    error: null,
    saved: false,
    loading: true,

    async init() {
      try {
        const [me, photosRes] = await Promise.all([api.me(), api.myPhotos()]);
        // Never leave the slider on a hardcoded default: saving would then
        // silently overwrite the user's real radius with 80.
        if (me.user.max_distance_km != null) this.maxDistanceKm = me.user.max_distance_km;
        this.bio = me.user.bio ?? null;
        this.spotifyAvatarUrl = me.user.spotify_avatar_url ?? null;
        this.photos = photosRes.photos;
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

    async uploadPhoto(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      this.photoError = null;
      if (this.photos.length >= this.maxPhotos) {
        this.photoError = `You can upload up to ${this.maxPhotos} photos.`;
        return;
      }
      try {
        const uploaded = await uploadPhotoFile(file);
        this.photos.push(uploaded);
      } catch (e) {
        console.error('Photo upload failed:', e);
        this.photoError = 'Could not upload that photo. Please try again.';
      }
    },

    async removePhoto(photoId) {
      this.photoError = null;
      try {
        await api.deletePhoto(photoId);
        this.photos = this.photos.filter((p) => p.photoId !== photoId);
      } catch (e) {
        this.photoError = 'Could not remove that photo. Please try again.';
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
