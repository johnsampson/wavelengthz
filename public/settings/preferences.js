import { api, INTENT_OPTIONS } from '../app.js';

const LOCATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_AGE = 18;
const MAX_AGE = 100;

export function createPreferencesApp() {
  return {
    maxDistanceKm: 80,
    ageMin: MIN_AGE,
    ageMax: MAX_AGE,
    activeAgeThumb: 'max',
    gender: '',
    seeking: '',
    intent: '',
    intentOptions: INTENT_OPTIONS,
    lat: null,
    lng: null,
    locationLabel: '',
    locationUpdatedAt: null,
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
        const me = await api.me();
        if (me.user.max_distance_km != null) this.maxDistanceKm = me.user.max_distance_km;
        if (me.user.age_min != null) this.ageMin = me.user.age_min;
        if (me.user.age_max != null) this.ageMax = me.user.age_max;
        this.gender = me.user.gender ?? '';
        this.seeking = me.user.seeking ?? '';
        // Falls back to unset (prompting a fresh pick) rather than keeping a
        // stale value INTENT_OPTIONS no longer offers -- e.g. 'making_friends'
        // (retired in favor of seeking:'friends') or 'dating_around' (retired
        // as a duplicate of 'something_casual').
        const loadedIntent = me.user.intent ?? '';
        this.intent = INTENT_OPTIONS.some((opt) => opt.value === loadedIntent) ? loadedIntent : '';
        this.lat = me.user.lat;
        this.lng = me.user.lng;
        this.locationLabel = me.user.location_label;
        this.locationUpdatedAt = me.user.location_updated_at;
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

    async save() {
      this.error = null;
      this.saved = false;
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
        // Re-fetched fresh so display_name/bio/date_of_birth -- Profile's
        // fields, not tracked as state on this page -- get echoed back
        // exactly as they are now, not clobbered by this page's save.
        const me = await api.me();
        await api.onboard({
          display_name: me.user.display_name ?? '',
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
  };
}
