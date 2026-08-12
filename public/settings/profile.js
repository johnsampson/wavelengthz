import { api } from '../app.js';
import { MAX_PHOTOS, uploadPhotoFile } from '../photos.js';
import { showErrorToast } from '../toast.js';

export function createProfileApp() {
  return {
    displayName: '',
    bio: '',
    photos: [],
    maxPhotos: MAX_PHOTOS,
    confirmingDelete: false,
    error: null,
    saved: false,
    loading: true,

    async init() {
      try {
        const [me, photosRes] = await Promise.all([api.me(), api.myPhotos()]);
        this.displayName = me.user.display_name ?? '';
        this.bio = me.user.bio ?? '';
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
      this.saved = false;
      if (!this.displayName.trim()) {
        showErrorToast('Please enter a display name.');
        return;
      }
      if (!/^[-A-Za-z0-9 ]+$/.test(this.displayName.trim())) {
        showErrorToast('Display name can only contain letters, numbers, dashes, and spaces.');
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
        const trimmedBio = this.bio.trim();
        await api.onboard({
          display_name: this.displayName.trim(),
          bio: trimmedBio || null,
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
        this.bio = trimmedBio;
        this.saved = true;
      } catch (e) {
        if (e.status === 400 && e.body?.error === 'invalid_intent') {
          showErrorToast("Please choose what you're interested in under Settings → Preferences first.");
        } else if (e.status === 400 && e.body?.error === 'invalid_bio') {
          showErrorToast('Your bio is too long, or contains language that isn\'t allowed.');
        } else {
          showErrorToast('Could not save your settings. Please try again.');
        }
      }
    },

    async uploadPhoto(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (this.photos.length >= this.maxPhotos) {
        showErrorToast(`You can upload up to ${this.maxPhotos} photos.`);
        return;
      }
      try {
        const uploaded = await uploadPhotoFile(file);
        this.photos.push(uploaded);
      } catch (e) {
        console.error('Photo upload failed:', e);
        showErrorToast('Could not upload that photo. Please try again.');
      }
    },

    async removePhoto(photoId) {
      try {
        await api.deletePhoto(photoId);
        this.photos = this.photos.filter((p) => p.photoId !== photoId);
      } catch (e) {
        showErrorToast('Could not remove that photo. Please try again.');
      }
    },

    async deleteAccount() {
      try {
        await api.deleteAccount();
        window.location.href = '/';
      } catch (e) {
        showErrorToast('Could not delete your account. Please try again.');
      }
    },
  };
}
