import { api } from '../app.js';
import { MAX_PHOTOS, uploadPhotoFile } from '../photos.js';

export function createProfileApp() {
  return {
    displayName: '',
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
        this.displayName = me.user.display_name ?? '';
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

    async save() {
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
      try {
        // Re-fetched fresh (not read from this page's own state) because
        // this page doesn't track gender/seeking/intent/location/max
        // distance/age range at all -- they live on Preferences now.
        // POST /api/onboarding rewrites its entire field set unconditionally,
        // so every one of those has to be echoed back here unedited, or
        // Preferences' saved values get wiped the next time someone saves
        // from this page.
        const me = await api.me();
        await api.onboard({
          display_name: this.displayName.trim(),
          bio: me.user.bio ?? null,
          date_of_birth: me.user.date_of_birth,
          location_label: me.user.location_label,
          lat: me.user.lat,
          lng: me.user.lng,
          max_distance_km: me.user.max_distance_km,
          age_min: me.user.age_min,
          age_max: me.user.age_max,
          gender: me.user.gender,
          seeking: me.user.seeking,
          intent: me.user.intent,
        });
        this.displayName = this.displayName.trim();
        this.saved = true;
      } catch (e) {
        if (e.status === 400 && e.body?.error === 'invalid_intent') {
          this.error = "Please choose what you're interested in under Settings → Preferences first.";
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
