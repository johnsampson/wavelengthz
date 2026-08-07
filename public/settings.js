import { api, INTENT_OPTIONS } from './app.js';
import { MAX_PHOTOS, uploadPhotoFile } from './photos.js';

const LOCATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Extracted from settings.html's inline script so the round-tripping logic
// below is directly testable (same pattern as swipe.js). The page just does
// `window.settingsApp = createSettingsApp`.
//
// Settings deliberately reuses POST /api/onboarding rather than introducing a
// separate PATCH /api/me. That endpoint does an unconditional `SET bio = ?`,
// so every field it owns has to be echoed back or it gets clobbered -- hence
// the fetch-then-resubmit-with-existing-values shape of both init() and
// updateDistance().
const MIN_AGE = 18;
const MAX_AGE = 100;

export function createSettingsApp() {
  return {
    maxDistanceKm: 80,
    ageMin: MIN_AGE,
    ageMax: MAX_AGE,
    activeAgeThumb: 'max',
    displayName: '',
    bio: null,
    userId: null,
    spotifyAvatarUrl: null,
    gender: '',
    seeking: '',
    intent: '',
    intentOptions: INTENT_OPTIONS,
    lat: null,
    lng: null,
    locationLabel: '',
    locationUpdatedAt: null,
    photos: [],
    maxPhotos: MAX_PHOTOS,
    photoError: null,
    confirmingDelete: false,
    error: null,
    saved: false,
    loading: true,

    get locationCooldownRemainingMs() {
      if (this.locationUpdatedAt == null) return 0;
      return Math.max(0, LOCATION_COOLDOWN_MS - (Date.now() - this.locationUpdatedAt));
    },

    get locationCooldownRemainingDays() {
      return Math.ceil(this.locationCooldownRemainingMs / (24 * 60 * 60 * 1000));
    },

    get ageMinPct() {
      return ((this.ageMin - MIN_AGE) / (MAX_AGE - MIN_AGE)) * 100;
    },

    get ageMaxPct() {
      return ((this.ageMax - MIN_AGE) / (MAX_AGE - MIN_AGE)) * 100;
    },

    get ageRangeLabel() {
      return `${this.ageMin} - ${this.ageMax >= MAX_AGE ? '100+' : this.ageMax}`;
    },

    async init() {
      try {
        const [me, photosRes] = await Promise.all([api.me(), api.myPhotos()]);
        // Never leave the slider on a hardcoded default: saving would then
        // silently overwrite the user's real radius with 80.
        if (me.user.max_distance_km != null) this.maxDistanceKm = me.user.max_distance_km;
        if (me.user.age_min != null) this.ageMin = me.user.age_min;
        if (me.user.age_max != null) this.ageMax = me.user.age_max;
        this.userId = me.user.id;
        this.displayName = me.user.display_name ?? '';
        this.bio = me.user.bio ?? null;
        this.spotifyAvatarUrl = me.user.spotify_avatar_url ?? null;
        this.gender = me.user.gender ?? '';
        this.seeking = me.user.seeking ?? '';
        this.intent = me.user.intent ?? '';
        this.lat = me.user.lat;
        this.lng = me.user.lng;
        this.locationLabel = me.user.location_label;
        this.locationUpdatedAt = me.user.location_updated_at;
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

    useBrowserLocation() {
      if (this.locationCooldownRemainingMs > 0) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.lat = pos.coords.latitude;
          this.lng = pos.coords.longitude;
          this.locationLabel = 'Current location';
        },
        () => {
          this.error = 'Location permission denied.';
        }
      );
    },

    handleAgeMinInput() {
      this.activeAgeThumb = 'min';
      if (this.ageMin > this.ageMax - 1) this.ageMin = this.ageMax - 1;
    },

    handleAgeMaxInput() {
      this.activeAgeThumb = 'max';
      if (this.ageMax < this.ageMin + 1) this.ageMax = this.ageMin + 1;
    },

    async updateDistance() {
      this.error = null;
      this.saved = false;
      if (!this.displayName.trim()) {
        this.error = 'Please enter a display name.';
        return;
      }
      if (!/^[-A-Za-z0-9 ]+$/.test(this.displayName.trim())) {
        this.error = 'Display name can only contain letters, numbers, dashes, and spaces.';
        return;
      }
      if (!this.gender) {
        this.error = 'Please select a gender.';
        return;
      }
      if (!this.seeking) {
        this.error = "Please select who you're seeking.";
        return;
      }
      if (!this.intent) {
        this.error = "Please select what you're interested in.";
        return;
      }
      try {
        const me = await api.me();
        await api.onboard({
          display_name: this.displayName.trim(),
          // bio is re-sent because /api/onboarding unconditionally writes it;
          // omitting it wipes the user's bio to NULL on every settings save.
          bio: me.user.bio ?? null,
          date_of_birth: me.user.date_of_birth,
          location_label: this.locationLabel,
          lat: this.lat,
          lng: this.lng,
          max_distance_km: this.maxDistanceKm,
          age_min: this.ageMin,
          age_max: this.ageMax,
          gender: this.gender,
          seeking: this.seeking,
          intent: this.intent,
        });
        this.displayName = this.displayName.trim();
        this.bio = me.user.bio ?? null;
        this.saved = true;
      } catch (e) {
        if (e.status === 429 && e.body?.error === 'location_change_cooldown') {
          this.locationUpdatedAt = Date.now() - LOCATION_COOLDOWN_MS + e.body.retryAfterMs;
          const days = this.locationCooldownRemainingDays;
          this.error = `You can only change your location once every 7 days. Try again in ${days} day${days === 1 ? '' : 's'}.`;
        } else if (e.status === 400 && e.body?.error === 'age_range_excludes_self') {
          this.error = 'Your age range must include your own age.';
        } else {
          this.error = 'Could not save your settings. Please try again.';
        }
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
