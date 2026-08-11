# Split Settings into Multiple Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `/settings` page with a hub-and-list menu — `/settings` becomes a simple menu, and Profile, Preferences, Notifications, and Account connections each become their own page.

**Architecture:** Four new self-contained Alpine pages under `public/settings/` (`profile.html`/`.js`, `preferences.html`/`.js`, `notifications.html`/`.js`, `connections.html`/`.js`), each following the exact same `createXApp()`-factory-plus-`init()` shape `settings.js` already uses. `public/settings.html`/`settings.js` are rewritten down to a plain list menu. Every page that saves via `POST /api/onboarding` (Profile, Preferences) re-fetches `api.me()` immediately before submitting and echoes back every field that endpoint owns — including the fields the *other* page edits — exactly matching how the current single form already echoes back `bio`/`date_of_birth` it never displays.

**Tech Stack:** Alpine.js, Vitest, Cloudflare Workers Static Assets (clean-URL resolution).

## Global Constraints

- `POST /api/onboarding` unconditionally rewrites its entire field set (`display_name`, `bio`, `date_of_birth`, `location_label`, `lat`, `lng`, `max_distance_km`, `age_min`, `age_max`, `gender`, `seeking`, `intent`) — every caller must echo back fields it doesn't own, or they get wiped to their JSON-serialized default.
- Every new page independently calls `api.me()` on `init()` and redirects to `/login` on a 401, matching the current page's exact error-handling shape.
- No backend route signatures change except the two hardcoded Spotify connect-intent redirect targets (Task 5).
- Full suite (`npx vitest run`) and `npx tsc --noEmit` clean is the acceptance bar for every task.

---

### Task 1: `nav.js` — highlight Settings for any `/settings/*` path

**Files:**
- Modify: `public/nav.js`
- Modify: `test/public/nav.test.ts`

**Interfaces:**
- Produces: `getActiveTab(pathname: string): string | null` now returns `/settings` for any pathname starting with `/settings` (previously exact-match only).

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('getActiveTab', ...)` block in `test/public/nav.test.ts`:

```typescript
  it('matches /settings for any nested settings sub-page, not just the exact path', () => {
    expect(getActiveTab('/settings/profile')).toBe('/settings');
    expect(getActiveTab('/settings/preferences')).toBe('/settings');
    expect(getActiveTab('/settings/notifications')).toBe('/settings');
    expect(getActiveTab('/settings/connections')).toBe('/settings');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public/nav.test.ts`
Expected: FAIL — `getActiveTab('/settings/profile')` currently returns `null` (exact-match against `NAV_ITEMS` finds nothing).

- [ ] **Step 3: Update `getActiveTab` in `public/nav.js`**

Replace:

```javascript
export function getActiveTab(pathname) {
  const item = NAV_ITEMS.find((i) => i.href === pathname);
  return item ? item.href : null;
}
```

with:

```javascript
export function getActiveTab(pathname) {
  // Exact match for four of the five tabs, but /settings now has real
  // sub-pages (/settings/profile, /settings/preferences, ...) that must
  // still highlight the same bottom-tab icon -- prefix-match only for
  // /settings specifically, since none of the other four tabs have
  // sub-pages and an exact match stays correct (and cheaper) for them.
  const item = NAV_ITEMS.find((i) => i.href === pathname || (i.href === '/settings' && pathname.startsWith('/settings/')));
  return item ? item.href : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/public/nav.test.ts`
Expected: PASS (all cases green, including every pre-existing test unaffected)

- [ ] **Step 5: Commit**

```bash
git add public/nav.js test/public/nav.test.ts
git commit -m "feat: highlight the Settings tab for any /settings/* sub-page"
```

---

### Task 2: Profile page

**Files:**
- Create: `public/settings/profile.html`
- Create: `public/settings/profile.js`
- Create: `test/public/settings/profile.test.ts`

**Interfaces:**
- Consumes: `api.me`, `api.myPhotos`, `api.onboard`, `api.deletePhoto`, `api.deleteAccount` (`public/app.js`); `MAX_PHOTOS`, `uploadPhotoFile` (`public/photos.js`); `mountHeader`, `mountNav` (`public/nav.js`).
- Produces: `createProfileApp()` returning `{ displayName, photos, maxPhotos, photoError, confirmingDelete, error, saved, loading, init(), save(), uploadPhoto(event), removePhoto(photoId), deleteAccount() }`.

- [ ] **Step 1: Verify nested static routing works before building on it**

This repo has never served a page from a path with more than one segment (`/matches`, `/settings`, etc. are all single-segment). Confirm the assumption holds before writing four pages against it:

```bash
mkdir -p public/settings
echo '<!DOCTYPE html><html><body>probe</body></html>' > public/settings/profile.html
npx wrangler dev &
sleep 3
curl -s http://127.0.0.1:8787/settings/profile
kill %1
```

Expected: the curl output contains `probe`. If it 404s instead, stop and report — the file/routing approach in this task needs to change before proceeding (this is not expected to happen; Cloudflare's Workers Static Assets clean-URL handling is documented to resolve nested files the same way as top-level ones).

- [ ] **Step 2: Write the failing tests**

```typescript
// test/public/settings/profile.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createProfileApp } from '../../../public/settings/profile.js';

function stubApi(user: Record<string, unknown>, photos: Array<Record<string, unknown>> = []) {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/me') return new Response(JSON.stringify({ user }), { status: 200 });
    if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
      return new Response(JSON.stringify({ photos }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    onboardBody: () => JSON.parse(calls.find((c) => c.path === '/api/onboarding')!.options.body),
  };
}

const ONBOARDED_USER = {
  id: 'u1',
  display_name: 'Jordan',
  bio: 'I like loud guitars',
  date_of_birth: '1995-01-01',
  location_label: 'Austin, TX',
  lat: 30.27,
  lng: -97.74,
  max_distance_km: 25,
  age_min: 25,
  age_max: 40,
  gender: 'male',
  seeking: 'female',
  intent: 'something_casual',
};

describe('profile page', () => {
  it('loads the existing display name', async () => {
    stubApi(ONBOARDED_USER);
    const app = createProfileApp();

    await app.init();

    expect(app.displayName).toBe('Jordan');
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('loads existing photos on init', async () => {
    stubApi(ONBOARDED_USER, [{ photoId: 'p1', url: '/photos/p1', position: 0 }]);
    const app = createProfileApp();

    await app.init();

    expect(app.photos).toEqual([{ photoId: 'p1', url: '/photos/p1', position: 0 }]);
    vi.unstubAllGlobals();
  });

  it('rejects saving a blank display name without a network call', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();

    app.displayName = '   ';
    await app.save();

    expect(app.error).toBeTruthy();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving a display name with disallowed characters without a network call', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();

    app.displayName = 'Jordan!!';
    await app.save();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('saves the trimmed display name and echoes back every field POST /api/onboarding owns, including the other page\'s fields', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();
    app.displayName = '  Jordan Two  ';

    await app.save();

    const body = api.onboardBody();
    expect(body.display_name).toBe('Jordan Two');
    // Fields this page never shows, echoed back unedited so Preferences'
    // values aren't clobbered by this page's save:
    expect(body.bio).toBe('I like loud guitars');
    expect(body.date_of_birth).toBe('1995-01-01');
    expect(body.location_label).toBe('Austin, TX');
    expect(body.lat).toBe(30.27);
    expect(body.lng).toBe(-97.74);
    expect(body.max_distance_km).toBe(25);
    expect(body.age_min).toBe(25);
    expect(body.age_max).toBe(40);
    expect(body.gender).toBe('male');
    expect(body.seeking).toBe('female');
    expect(body.intent).toBe('something_casual');
    expect(app.displayName).toBe('Jordan Two');
    expect(app.saved).toBe(true);
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createProfileApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createProfileApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('uploads a photo and appends it to the list', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      }
      if (path === '/api/photos' && options.method === 'POST') {
        return new Response(JSON.stringify({ photoId: 'p2', url: '/photos/p2' }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createProfileApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toEqual([{ photoId: 'p2', url: '/photos/p2' }]);
    expect(app.photoError).toBeNull();
    vi.unstubAllGlobals();
  });

  it('refuses to upload past the 10-photo cap without a network call', async () => {
    const photos = Array.from({ length: 10 }, (_, i) => ({ photoId: `p${i}`, url: `/photos/p${i}`, position: i }));
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createProfileApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toHaveLength(10);
    expect(app.photoError).toContain('10');
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/photos' && c[1]?.method === 'POST')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('removes a photo from the list', async () => {
    const api = stubApi(ONBOARDED_USER, [
      { photoId: 'p1', url: '/photos/p1', position: 0 },
      { photoId: 'p2', url: '/photos/p2', position: 1 },
    ]);
    const app = createProfileApp();
    await app.init();

    await app.removePhoto('p1');

    expect(app.photos.map((p: any) => p.photoId)).toEqual(['p2']);
    expect(api.calls.some((c) => c.path === '/api/photos/p1' && c.options.method === 'DELETE')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('deletes the account and redirects to the deck', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos') return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      if (path === '/api/account' && options.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createProfileApp();
    await app.init();

    await app.deleteAccount();

    expect(fakeWindow.location.href).toBe('/');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/public/settings/profile.test.ts`
Expected: FAIL — `public/settings/profile.js` does not exist.

- [ ] **Step 4: Write `public/settings/profile.js`**

```javascript
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
```

- [ ] **Step 5: Write `public/settings/profile.html`**

Replace the probe content from Step 1 with the real page:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Profile</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-base text-neutral-50 p-4 pb-24" x-data="profileApp()">
  <div id="wl-header-root"></div>
  <a href="/settings" class="mx-auto mb-2 block max-w-md text-sm text-neutral-400">&larr; Settings</a>
  <h1 class="mx-auto mb-4 max-w-md text-2xl font-bold">Profile</h1>

  <p x-show="error" x-text="error" class="mx-auto mb-4 max-w-md text-red-400" role="alert"></p>
  <p x-show="saved" class="mx-auto mb-4 max-w-md text-brand-400">Saved.</p>

  <form class="card mx-auto flex max-w-md flex-col gap-4 p-5" @submit.prevent="save()">
    <label class="flex flex-col gap-1">
      <span class="field-label">Display name</span>
      <input class="field" type="text" x-model="displayName" maxlength="50" pattern="[-A-Za-z0-9 ]+" :disabled="loading" />
    </label>
    <button type="submit" class="btn-primary" :disabled="loading">Save</button>
  </form>

  <div class="card mx-auto mt-4 flex max-w-md flex-col gap-2 p-5">
    <span class="field-label">Photos (<span x-text="photos.length"></span>/<span x-text="maxPhotos"></span>)</span>
    <label
      class="btn-secondary inline-flex w-fit cursor-pointer items-center"
      :class="photos.length >= maxPhotos ? 'pointer-events-none opacity-50' : ''"
    >
      Choose file
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        @change="uploadPhoto($event)"
        aria-label="Upload a profile photo"
        class="sr-only"
        :disabled="photos.length >= maxPhotos"
      />
    </label>
    <p x-show="photoError" x-text="photoError" class="text-sm text-red-400" role="alert"></p>
    <div class="grid grid-cols-4 gap-2">
      <template x-for="photo in photos" :key="photo.photoId">
        <div class="relative">
          <img :src="photo.url" alt="" class="aspect-square w-full rounded-lg object-cover ring-1 ring-white/10" />
          <button
            type="button"
            class="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs text-white"
            @click="removePhoto(photo.photoId)"
            aria-label="Remove photo"
          >✕</button>
        </div>
      </template>
    </div>
  </div>

  <div class="mx-auto mt-8 max-w-md border-t border-white/10 pt-4">
    <button class="btn-ghost text-red-400" @click="confirmingDelete = true" x-show="!confirmingDelete">
      Delete my account
    </button>
    <div x-show="confirmingDelete" class="card flex flex-col gap-3 p-4">
      <p role="alert" class="text-sm text-neutral-200">This deletes your account. Are you sure?</p>
      <div class="flex gap-2">
        <button class="btn-danger flex-1" @click="deleteAccount()">Yes, delete</button>
        <button class="btn-secondary flex-1" @click="confirmingDelete = false">Cancel</button>
      </div>
    </div>
  </div>

  <script type="module">
    import { createProfileApp } from '/settings/profile.js';
    import { mountHeader, mountNav } from '/nav.js';
    mountHeader();
    mountNav();

    window.profileApp = createProfileApp;
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <div id="wl-nav-root"></div>
</body>
</html>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/public/settings/profile.test.ts`
Expected: PASS (11/11)

- [ ] **Step 7: Manually verify in a browser**

Run: `npx wrangler dev`, log in, navigate to `http://127.0.0.1:8787/settings/profile` directly (typed in the address bar, not clicked from a link yet — nothing links here until Task 6). Confirm the page loads, shows your display name and photos, and the bottom nav's Settings icon is highlighted.

- [ ] **Step 8: Commit**

```bash
git add public/settings/profile.html public/settings/profile.js test/public/settings/profile.test.ts
git commit -m "feat: add /settings/profile page"
```

---

### Task 3: Preferences page

**Files:**
- Create: `public/settings/preferences.html`
- Create: `public/settings/preferences.js`
- Create: `test/public/settings/preferences.test.ts`

**Interfaces:**
- Consumes: `api.me`, `api.onboard` (`public/app.js`); `INTENT_OPTIONS` (`public/app.js`).
- Produces: `createPreferencesApp()` returning `{ maxDistanceKm, ageMin, ageMax, activeAgeThumb, gender, seeking, intent, intentOptions, lat, lng, locationLabel, locationUpdatedAt, error, saved, loading, locationCooldownRemainingMs (getter), locationCooldownRemainingDays (getter), ageMinPct (getter), ageMaxPct (getter), ageRangeLabel (getter), init(), useBrowserLocation(), handleAgeMinInput(), handleAgeMaxInput(), save() }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/public/settings/preferences.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPreferencesApp } from '../../../public/settings/preferences.js';

function stubApi(user: Record<string, unknown>) {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/me') return new Response(JSON.stringify({ user }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    onboardBody: () => JSON.parse(calls.find((c) => c.path === '/api/onboarding')!.options.body),
  };
}

const ONBOARDED_USER = {
  id: 'u1',
  display_name: 'Jordan',
  bio: 'I like loud guitars',
  date_of_birth: '1995-01-01',
  location_label: 'Austin, TX',
  lat: 30.27,
  lng: -97.74,
  location_updated_at: null,
  max_distance_km: 25,
  age_min: 25,
  age_max: 40,
  gender: 'male',
  seeking: 'female',
  intent: 'something_casual',
};

describe('preferences page', () => {
  it('loads the real max_distance_km instead of leaving the hardcoded default', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    expect(app.maxDistanceKm).toBe(80); // placeholder before init

    await app.init();

    expect(app.maxDistanceKm).toBe(25);
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('loads the real age range instead of leaving the hardcoded 18-100 default', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    expect(app.ageMin).toBe(18);
    expect(app.ageMax).toBe(100);

    await app.init();

    expect(app.ageMin).toBe(25);
    expect(app.ageMax).toBe(40);
    vi.unstubAllGlobals();
  });

  it('round-trips a still-valid intent unchanged', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();

    await app.init();

    expect(app.intent).toBe('something_casual');
    vi.unstubAllGlobals();
  });

  it('resets a retired intent value to unset instead of keeping it stale', async () => {
    stubApi({ ...ONBOARDED_USER, intent: 'making_friends' });
    const app = createPreferencesApp();

    await app.init();

    expect(app.intent).toBe('');
    vi.unstubAllGlobals();
  });

  it('resets the retired dating_around intent to unset too, not just making_friends', async () => {
    stubApi({ ...ONBOARDED_USER, intent: 'dating_around' });
    const app = createPreferencesApp();

    await app.init();

    expect(app.intent).toBe('');
    vi.unstubAllGlobals();
  });

  it('loads gender and seeking on init', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();

    await app.init();

    expect(app.gender).toBe('male');
    expect(app.seeking).toBe('female');
    vi.unstubAllGlobals();
  });

  it('rejects saving without a gender selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.gender = '';

    await app.save();

    expect(app.error).toBeTruthy();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving without seeking selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.seeking = '';

    await app.save();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving without intent selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.intent = '';

    await app.save();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('saves edited preferences and echoes back display_name/bio/date_of_birth unedited', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.maxDistanceKm = 50;
    app.ageMin = 22;
    app.ageMax = 55;

    await app.save();

    const body = api.onboardBody();
    expect(body.max_distance_km).toBe(50);
    expect(body.age_min).toBe(22);
    expect(body.age_max).toBe(55);
    expect(body.gender).toBe('male');
    expect(body.seeking).toBe('female');
    expect(body.intent).toBe('something_casual');
    // Profile's fields, echoed back unedited:
    expect(body.display_name).toBe('Jordan');
    expect(body.bio).toBe('I like loud guitars');
    expect(body.date_of_birth).toBe('1995-01-01');
    expect(app.saved).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sends bio: null rather than undefined for a user who never wrote one', async () => {
    const api = stubApi({ ...ONBOARDED_USER, bio: null });
    const app = createPreferencesApp();
    await app.init();

    await app.save();

    const body = api.onboardBody();
    expect('bio' in body).toBe(true);
    expect(body.bio).toBeNull();
    vi.unstubAllGlobals();
  });

  it('has no cooldown when location_updated_at is null', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();

    expect(app.locationCooldownRemainingMs).toBe(0);
    vi.unstubAllGlobals();
  });

  it('reports the remaining cooldown when location was changed recently', async () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    stubApi({ ...ONBOARDED_USER, location_updated_at: threeDaysAgo });
    const app = createPreferencesApp();
    await app.init();

    expect(app.locationCooldownRemainingMs).toBeGreaterThan(0);
    expect(app.locationCooldownRemainingDays).toBe(4);
    vi.unstubAllGlobals();
  });

  it('shows a friendly cooldown message when the server rejects a location change', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/onboarding') {
        return new Response(JSON.stringify({ error: 'location_change_cooldown', retryAfterMs: 2 * 24 * 60 * 60 * 1000 }), { status: 429 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createPreferencesApp();
    await app.init();

    await app.save();

    expect(app.error).toContain('7 days');
    expect(app.error).toContain('2 days');
    expect(app.saved).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows "100+" in the range label when the max is uncapped', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();

    expect(app.ageRangeLabel).toBe('18 - 100+');
    vi.unstubAllGlobals();
  });

  it('clamps the minimum thumb so it can never cross the maximum', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.ageMax = 30;

    app.ageMin = 30;
    app.handleAgeMinInput();

    expect(app.ageMin).toBe(29);
    expect(app.activeAgeThumb).toBe('min');
    vi.unstubAllGlobals();
  });

  it('clamps the maximum thumb so it can never cross the minimum', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.ageMin = 40;

    app.ageMax = 40;
    app.handleAgeMaxInput();

    expect(app.ageMax).toBe(41);
    expect(app.activeAgeThumb).toBe('max');
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createPreferencesApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createPreferencesApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public/settings/preferences.test.ts`
Expected: FAIL — `public/settings/preferences.js` does not exist.

- [ ] **Step 3: Write `public/settings/preferences.js`**

```javascript
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
```

- [ ] **Step 4: Write `public/settings/preferences.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Preferences</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-base text-neutral-50 p-4 pb-24" x-data="preferencesApp()">
  <div id="wl-header-root"></div>
  <a href="/settings" class="mx-auto mb-2 block max-w-md text-sm text-neutral-400">&larr; Settings</a>
  <h1 class="mx-auto mb-4 max-w-md text-2xl font-bold">Preferences</h1>

  <p x-show="error" x-text="error" class="mx-auto mb-4 max-w-md text-red-400" role="alert"></p>
  <p x-show="saved" class="mx-auto mb-4 max-w-md text-brand-400">Saved.</p>

  <form class="card mx-auto flex max-w-md flex-col gap-4 p-5" @submit.prevent="save()">
    <div class="flex flex-col gap-1">
      <span class="field-label">Gender</span>
      <div class="flex gap-2 rounded-full bg-surface2 p-1">
        <button type="button" class="pill-toggle flex-1" :class="gender === 'male' ? 'pill-toggle-active' : 'pill-toggle-inactive'" :disabled="loading" @click="gender = 'male'">Male</button>
        <button type="button" class="pill-toggle flex-1" :class="gender === 'female' ? 'pill-toggle-active' : 'pill-toggle-inactive'" :disabled="loading" @click="gender = 'female'">Female</button>
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <span class="field-label">Seeking</span>
      <div class="flex gap-2 rounded-full bg-surface2 p-1">
        <button type="button" class="pill-toggle flex-1" :class="seeking === 'male' ? 'pill-toggle-active' : 'pill-toggle-inactive'" :disabled="loading" @click="seeking = 'male'">Male</button>
        <button type="button" class="pill-toggle flex-1" :class="seeking === 'female' ? 'pill-toggle-active' : 'pill-toggle-inactive'" :disabled="loading" @click="seeking = 'female'">Female</button>
        <button type="button" class="pill-toggle flex-1" :class="seeking === 'friends' ? 'pill-toggle-active' : 'pill-toggle-inactive'" :disabled="loading" @click="seeking = 'friends'">Friends</button>
      </div>
      <p x-show="seeking === 'friends'" class="text-xs text-neutral-400">You'll match with anyone else also seeking friends, regardless of gender.</p>
    </div>

    <div class="flex flex-col gap-1">
      <span class="field-label">I'm interested in</span>
      <div class="flex flex-wrap gap-2">
        <template x-for="opt in intentOptions" :key="opt.value">
          <button
            type="button"
            class="pill-toggle"
            :class="intent === opt.value ? 'pill-toggle-active' : 'pill-toggle-inactive'"
            :disabled="loading"
            @click="intent = opt.value"
            x-text="opt.label"
          ></button>
        </template>
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <span class="field-label">Location</span>
      <p class="text-sm text-neutral-400" x-text="locationLabel || 'Not set'"></p>
      <button
        type="button"
        class="btn-secondary"
        :disabled="loading || locationCooldownRemainingMs > 0"
        @click="useBrowserLocation()"
      >
        📍 Update my current location
      </button>
      <p x-show="locationCooldownRemainingMs > 0" class="text-sm text-neutral-500">
        You can change your location again in <span x-text="locationCooldownRemainingDays"></span> day<span x-show="locationCooldownRemainingDays !== 1">s</span>.
      </p>
    </div>

    <label class="flex flex-col gap-1">
      <span class="field-label">Max distance (km): <span x-text="loading ? '…' : maxDistanceKm" class="text-neutral-200 normal-case"></span></span>
      <input type="range" min="5" max="200" x-model.number="maxDistanceKm" :disabled="loading" class="accent-brand-500" />
    </label>

    <div class="flex flex-col gap-1">
      <span class="field-label">Age range: <span x-text="loading ? '…' : ageRangeLabel" class="text-neutral-200 normal-case"></span></span>
      <div class="age-range-slider">
        <span class="age-range-bubble" :style="`left: ${ageMinPct}%`" x-text="ageMin"></span>
        <span class="age-range-bubble" :style="`left: ${ageMaxPct}%`" x-text="ageMax >= 100 ? '100+' : ageMax"></span>
        <div class="age-range-track"></div>
        <div class="age-range-fill" :style="`left: ${ageMinPct}%; right: ${100 - ageMaxPct}%`"></div>
        <input
          type="range"
          min="18"
          max="100"
          x-model.number="ageMin"
          @input="handleAgeMinInput()"
          :disabled="loading"
          :style="`z-index: ${activeAgeThumb === 'min' ? 5 : 3}`"
          class="age-range-input"
          aria-label="Minimum age"
        />
        <input
          type="range"
          min="18"
          max="100"
          x-model.number="ageMax"
          @input="handleAgeMaxInput()"
          :disabled="loading"
          :style="`z-index: ${activeAgeThumb === 'max' ? 5 : 4}`"
          class="age-range-input"
          aria-label="Maximum age"
        />
      </div>
    </div>

    <button type="submit" class="btn-primary" :disabled="loading">Save</button>
  </form>

  <script type="module">
    import { createPreferencesApp } from '/settings/preferences.js';
    import { mountHeader, mountNav } from '/nav.js';
    mountHeader();
    mountNav();

    window.preferencesApp = createPreferencesApp;
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <div id="wl-nav-root"></div>
</body>
</html>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/public/settings/preferences.test.ts`
Expected: PASS (19/19)

- [ ] **Step 6: Commit**

```bash
git add public/settings/preferences.html public/settings/preferences.js test/public/settings/preferences.test.ts
git commit -m "feat: add /settings/preferences page"
```

---

### Task 4: Notifications page

**Files:**
- Create: `public/settings/notifications.html`
- Create: `public/settings/notifications.js`
- Create: `test/public/settings/notifications.test.ts`

**Interfaces:**
- Consumes: `api.pushVapidPublicKey`, `api.pushSubscribe`, `api.pushUnsubscribe` (`public/app.js`).
- Produces: `createNotificationsApp()` returning `{ pushSupported, pushEnabled, pushPermissionDenied, showIosInstallBanner, error, loading, init(), enablePush(), disablePush(), dismissIosInstallBanner() }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/public/settings/notifications.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createNotificationsApp } from '../../../public/settings/notifications.js';

function stubApi() {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/push/vapid-public-key') {
      return new Response(JSON.stringify({ publicKey: 'BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function fakeServiceWorker(subscription: Record<string, unknown> | null) {
  const sub = subscription && typeof subscription.toJSON !== 'function'
    ? { ...subscription, toJSON: () => ({ endpoint: subscription.endpoint, keys: subscription.keys ?? { p256dh: 'p', auth: 'a' } }) }
    : subscription;
  return {
    ready: Promise.resolve({
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async () => ({
          endpoint: 'https://push.example/new',
          toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }),
        }),
      },
    }),
  };
}

describe('notifications page', () => {
  it('init() detects an existing subscription as pushEnabled and re-subscribes to re-point ownership', async () => {
    const { calls } = stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows)',
      serviceWorker: fakeServiceWorker({ endpoint: 'https://push.example/existing', keys: { p256dh: 'p1', auth: 'a1' } }),
    });
    vi.stubGlobal('Notification', { permission: 'granted' });

    const app = createNotificationsApp();
    await app.init();

    expect(app.pushSupported).toBe(true);
    expect(app.pushEnabled).toBe(true);
    const subscribeCall = calls.find((c) => c.path === '/api/push/subscribe');
    expect(subscribeCall).toBeTruthy();
    expect(JSON.parse(subscribeCall!.options.body)).toEqual({ endpoint: 'https://push.example/existing', keys: { p256dh: 'p1', auth: 'a1' } });

    vi.unstubAllGlobals();
  });

  it('enablePush() requests permission, subscribes, and posts the subscription', async () => {
    const { calls } = stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker(null) });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });

    const app = createNotificationsApp();
    await app.init();
    await app.enablePush();

    expect(app.pushEnabled).toBe(true);
    const subscribeCall = calls.find((c) => c.path === '/api/push/subscribe')!;
    expect(JSON.parse(subscribeCall.options.body)).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } });

    vi.unstubAllGlobals();
  });

  it('enablePush() sets pushPermissionDenied and does not subscribe when permission is denied', async () => {
    const { calls } = stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker(null) });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'denied' });

    const app = createNotificationsApp();
    await app.init();
    await app.enablePush();

    expect(app.pushEnabled).toBe(false);
    expect(app.pushPermissionDenied).toBe(true);
    expect(calls.some((c) => c.path === '/api/push/subscribe')).toBe(false);

    vi.unstubAllGlobals();
  });

  it('disablePush() unsubscribes and posts the endpoint to /api/push/unsubscribe', async () => {
    const { calls } = stubApi();
    const unsubscribe = vi.fn(async () => true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows)',
      serviceWorker: fakeServiceWorker({ endpoint: 'https://push.example/existing', unsubscribe }),
    });
    vi.stubGlobal('Notification', { permission: 'granted' });

    const app = createNotificationsApp();
    await app.init();
    await app.disablePush();

    expect(unsubscribe).toHaveBeenCalled();
    expect(app.pushEnabled).toBe(false);
    const unsubCall = calls.find((c) => c.path === '/api/push/unsubscribe')!;
    expect(JSON.parse(unsubCall.options.body)).toEqual({ endpoint: 'https://push.example/existing' });

    vi.unstubAllGlobals();
  });

  it('shows the iOS install banner only on non-standalone iOS Safari, and hides it once dismissed', async () => {
    const store: Record<string, string> = {};
    stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });

    const app = createNotificationsApp();
    await app.init();
    expect(app.showIosInstallBanner).toBe(true);

    app.dismissIosInstallBanner();
    expect(app.showIosInstallBanner).toBe(false);

    const app2 = createNotificationsApp();
    await app2.init();
    expect(app2.showIosInstallBanner).toBe(false);

    vi.unstubAllGlobals();
  });

  it('does not show the iOS install banner on Android', async () => {
    stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

    const app = createNotificationsApp();
    await app.init();
    expect(app.showIosInstallBanner).toBe(false);

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public/settings/notifications.test.ts`
Expected: FAIL — `public/settings/notifications.js` does not exist.

- [ ] **Step 3: Write `public/settings/notifications.js`**

```javascript
import { api } from '../app.js';

// Converts the VAPID public key (base64url, from GET /api/push/vapid-public-key)
// into the Uint8Array pushManager.subscribe()'s applicationServerKey expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function createNotificationsApp() {
  return {
    pushSupported: false,
    pushEnabled: false,
    pushPermissionDenied: false,
    showIosInstallBanner: false,
    error: null,
    loading: true,

    async init() {
      try {
        if (typeof window !== 'undefined') {
          const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
          const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true;
          this.showIosInstallBanner = isIos && !isStandalone && !localStorage.getItem('wl_ios_install_dismissed');

          this.pushSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof Notification !== 'undefined';
          if (this.pushSupported) {
            this.pushPermissionDenied = Notification.permission === 'denied';
            // navigator.serviceWorker.ready never rejects, and never
            // resolves at all if no service worker has been registered for
            // this page's scope yet (the SW is only registered from
            // index.html). Raced against a timeout so a missing
            // registration degrades pushSupported/pushEnabled to their
            // false defaults instead of leaving `loading` stuck true
            // forever.
            const existingSubscription = await Promise.race([
              navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()),
              new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
            ]);
            this.pushEnabled = existingSubscription != null;
            if (existingSubscription) {
              // A browser's push subscription belongs to whichever account
              // last subscribed on this device, not necessarily the one now
              // logged in. Re-POSTing it re-points ownership at the current
              // session's user via the subscribe route's
              // ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id.
              // Same timeout guard as the serviceWorker.ready check above.
              try {
                await Promise.race([
                  api.pushSubscribe(existingSubscription.toJSON()),
                  new Promise((resolve) => setTimeout(resolve, 4000)),
                ]);
              } catch (err) {
                console.error('Re-subscribing existing push subscription failed:', err);
              }
            }
          }
        }
      } catch (e) {
        this.error = 'Could not load notification settings. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    async enablePush() {
      this.error = null;
      try {
        const permission = await Notification.requestPermission();
        this.pushPermissionDenied = permission === 'denied';
        if (permission !== 'granted') return;

        const { publicKey } = await api.pushVapidPublicKey();
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await api.pushSubscribe(subscription.toJSON());
        this.pushEnabled = true;
      } catch (e) {
        console.error('Enable notifications failed:', e);
        this.error = 'Could not enable notifications. Please try again.';
      }
    },

    async disablePush() {
      this.error = null;
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await api.pushUnsubscribe(subscription.endpoint);
          await subscription.unsubscribe();
        }
        this.pushEnabled = false;
      } catch (e) {
        console.error('Disable notifications failed:', e);
        this.error = 'Could not disable notifications. Please try again.';
      }
    },

    dismissIosInstallBanner() {
      this.showIosInstallBanner = false;
      if (typeof localStorage !== 'undefined') localStorage.setItem('wl_ios_install_dismissed', '1');
    },
  };
}
```

- [ ] **Step 4: Write `public/settings/notifications.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Notifications</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-base text-neutral-50 p-4 pb-24" x-data="notificationsApp()">
  <div id="wl-header-root"></div>
  <a href="/settings" class="mx-auto mb-2 block max-w-md text-sm text-neutral-400">&larr; Settings</a>
  <h1 class="mx-auto mb-4 max-w-md text-2xl font-bold">Notifications</h1>

  <p x-show="error" x-text="error" class="mx-auto mb-4 max-w-md text-red-400" role="alert"></p>

  <div x-show="showIosInstallBanner" class="card mx-auto mb-4 max-w-md p-4 text-sm">
    <p class="font-semibold text-neutral-200">Get notifications on iPhone</p>
    <p class="mt-1 text-neutral-400">Tap the Share button, then "Add to Home Screen" -- notifications only work once Wavelengthz is installed this way.</p>
    <button type="button" class="btn-ghost mt-2" @click="dismissIosInstallBanner()">Got it</button>
  </div>

  <div x-show="pushSupported" class="card mx-auto mb-4 flex max-w-md items-center justify-between p-4">
    <div class="text-sm">
      <p class="font-semibold text-neutral-200">Notifications</p>
      <p class="text-neutral-500" x-show="!pushPermissionDenied">Get notified about new matches and messages.</p>
      <p class="text-neutral-500" x-show="pushPermissionDenied">Blocked in your browser settings -- notifications can't be re-requested from here.</p>
    </div>
    <button type="button" class="btn-secondary" :disabled="pushPermissionDenied" @click="pushEnabled ? disablePush() : enablePush()">
      <span x-text="pushEnabled ? 'On' : 'Off'"></span>
    </button>
  </div>

  <p x-show="!loading && !pushSupported" class="mx-auto max-w-md text-center text-sm text-neutral-500">
    Notifications aren't supported in this browser.
  </p>

  <script type="module">
    import { createNotificationsApp } from '/settings/notifications.js';
    import { mountHeader, mountNav } from '/nav.js';
    mountHeader();
    mountNav();

    window.notificationsApp = createNotificationsApp;
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <div id="wl-nav-root"></div>
</body>
</html>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/public/settings/notifications.test.ts`
Expected: PASS (6/6)

- [ ] **Step 6: Commit**

```bash
git add public/settings/notifications.html public/settings/notifications.js test/public/settings/notifications.test.ts
git commit -m "feat: add /settings/notifications page"
```

---

### Task 5: Account connections page

**Files:**
- Create: `public/settings/connections.html`
- Create: `public/settings/connections.js`
- Create: `test/public/settings/connections.test.ts`
- Modify: `src/routes/auth.ts`
- Modify: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `api.me` (`public/app.js`).
- Produces: `createConnectionsApp()` returning `{ hasSpotify, spotifyAvatarUrl, info, error, loading, init() }`.

- [ ] **Step 1: Update the Spotify connect-intent redirect targets**

The "Connect Spotify" button now lives on this page, not the old single `/settings`. The backend's connect-intent OAuth callback hardcodes its redirect target — update both to land back on this page. In `src/routes/auth.ts`, change:

```typescript
          const headers = new Headers({ Location: '/settings?spotify_error=already_linked' });
```

to:

```typescript
          const headers = new Headers({ Location: '/settings/connections?spotify_error=already_linked' });
```

and change:

```typescript
        const headers = new Headers({ Location: '/settings?spotify_connected=1' });
```

to:

```typescript
        const headers = new Headers({ Location: '/settings/connections?spotify_connected=1' });
```

Update the two matching assertions in `test/routes/auth.test.ts`:

```typescript
    expect(res.headers.get('Location')).toBe('/settings/connections?spotify_connected=1');
```

and:

```typescript
    expect(res.headers.get('Location')).toBe('/settings/connections?spotify_error=already_linked');
```

- [ ] **Step 2: Run the auth route tests to verify the redirect-target change is correct**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: PASS — both updated assertions match the new redirect targets.

- [ ] **Step 3: Write the failing frontend tests**

```typescript
// test/public/settings/connections.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createConnectionsApp } from '../../../public/settings/connections.js';

function stubApi(user: Record<string, unknown>) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/me') return new Response(JSON.stringify({ user, hasSpotify: user.hasSpotify ?? false }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('connections page', () => {
  it('loads hasSpotify and the avatar url', async () => {
    stubApi({ id: 'u1', spotify_avatar_url: 'https://img.example/avatar.jpg', hasSpotify: true });
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.hasSpotify).toBe(true);
    expect(app.spotifyAvatarUrl).toBe('https://img.example/avatar.jpg');
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('leaves the avatar null when the account has none', async () => {
    stubApi({ id: 'u1', spotify_avatar_url: null, hasSpotify: false });
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.spotifyAvatarUrl).toBeNull();
    expect(app.hasSpotify).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows a confirmation message and strips the query string after a successful connect', async () => {
    stubApi({ id: 'u1', hasSpotify: true });
    const fakeWindow = { location: { search: '?spotify_connected=1' }, history: { replaceState: vi.fn() } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(app.info).toBe('Spotify connected.');
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/settings/connections');
    vi.unstubAllGlobals();
  });

  it('shows an already-linked error and strips the query string after a failed connect', async () => {
    stubApi({ id: 'u1', hasSpotify: false });
    const fakeWindow = { location: { search: '?spotify_error=already_linked' }, history: { replaceState: vi.fn() } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(app.error).toContain('already linked');
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/settings/connections');
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '', search: '' }, history: { replaceState: () => {} } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/public/settings/connections.test.ts`
Expected: FAIL — `public/settings/connections.js` does not exist.

- [ ] **Step 5: Write `public/settings/connections.js`**

```javascript
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
```

- [ ] **Step 6: Write `public/settings/connections.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Account connections</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-base text-neutral-50 p-4 pb-24" x-data="connectionsApp()">
  <div id="wl-header-root"></div>
  <a href="/settings" class="mx-auto mb-2 block max-w-md text-sm text-neutral-400">&larr; Settings</a>
  <h1 class="mx-auto mb-4 max-w-md text-2xl font-bold">Account connections</h1>

  <p x-show="info" x-text="info" class="mx-auto mb-4 max-w-md text-brand-400" role="status"></p>
  <p x-show="error" x-text="error" class="mx-auto mb-4 max-w-md text-red-400" role="alert"></p>

  <div x-show="hasSpotify" class="mx-auto mb-4 flex max-w-md items-center gap-3">
    <img :src="spotifyAvatarUrl" alt="" class="h-12 w-12 rounded-full object-cover ring-1 ring-white/10" />
    <div class="text-sm">
      <p class="font-semibold text-neutral-200">Connected via Spotify</p>
      <p class="text-neutral-500">This photo is never shown to matches -- it's just your account identity.</p>
    </div>
  </div>
  <div x-show="!hasSpotify" class="mx-auto mb-4 max-w-md">
    <a href="/login/spotify?intent=connect" class="btn-primary block w-full text-center">Connect Spotify</a>
    <p class="mt-1 text-center text-xs text-neutral-500">Link your Spotify account for music-taste matching.</p>
  </div>

  <script type="module">
    import { createConnectionsApp } from '/settings/connections.js';
    import { mountHeader, mountNav } from '/nav.js';
    mountHeader();
    mountNav();

    window.connectionsApp = createConnectionsApp;
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <div id="wl-nav-root"></div>
</body>
</html>
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/public/settings/connections.test.ts`
Expected: PASS (6/6)

- [ ] **Step 8: Run the full suite and type-check**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all green, zero errors.

- [ ] **Step 9: Commit**

```bash
git add public/settings/connections.html public/settings/connections.js test/public/settings/connections.test.ts src/routes/auth.ts test/routes/auth.test.ts
git commit -m "feat: add /settings/connections page, retarget Spotify connect-intent redirect"
```

---

### Task 6: Rewrite the Settings hub as a list menu

**Files:**
- Rewrite: `public/settings.html`
- Rewrite: `public/settings.js`
- Rewrite: `test/public/settings.test.ts`

**Interfaces:**
- Consumes: `api.me` (`public/app.js`).
- Produces: `createSettingsApp()` returning `{ userId, loading, error, init(), logout() }` — a much smaller surface than before; every other field/method moved to Tasks 2-5.

This is the last task — every destination page already exists and is independently verified working, so this task can safely replace the monolithic page with a menu that links to them.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `test/public/settings.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createSettingsApp } from '../../public/settings.js';

function stubApi(user: Record<string, unknown>) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/me') return new Response(JSON.stringify({ user }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

describe('settings hub', () => {
  it('loads the caller\'s own id so the preview-profile link can use it', async () => {
    stubApi({ id: 'u1' });
    const app = createSettingsApp();
    expect(app.userId).toBeNull();

    await app.init();

    expect(app.userId).toBe('u1');
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createSettingsApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('logs out and lands on the deck (not /login, which would silently re-trigger Spotify OAuth)', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/logout') return new Response('ok', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.logout();

    expect(fetchMock).toHaveBeenCalledWith('/logout', expect.objectContaining({ method: 'POST' }));
    expect(fakeWindow.location.href).toBe('/');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces an error and does not redirect when the logout request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.logout();

    expect(fakeWindow.location.href).toBe('');
    expect(app.error).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public/settings.test.ts`
Expected: FAIL — the old `settings.js` still has the full old surface; some of these assertions (e.g. `app.userId` starting `null` rather than `undefined` is fine, but the old `init()` also calls `api.myPhotos()`, which this stub doesn't provide) will error or behave unexpectedly.

- [ ] **Step 3: Rewrite `public/settings.js`**

```javascript
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
```

- [ ] **Step 4: Rewrite `public/settings.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Settings</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-base text-neutral-50 p-4 pb-24" x-data="settingsApp()">
  <div id="wl-header-root"></div>
  <h1 class="mx-auto mb-4 max-w-md text-2xl font-bold">Settings</h1>

  <p x-show="error" x-text="error" class="mx-auto mb-4 max-w-md text-red-400" role="alert"></p>

  <ul class="mx-auto flex max-w-md flex-col gap-2">
    <li>
      <a href="/settings/profile" class="card flex items-center justify-between p-4">
        <span class="font-semibold text-neutral-100">Profile</span>
        <span class="text-neutral-500">&rarr;</span>
      </a>
    </li>
    <li>
      <a href="/settings/preferences" class="card flex items-center justify-between p-4">
        <span class="font-semibold text-neutral-100">Preferences</span>
        <span class="text-neutral-500">&rarr;</span>
      </a>
    </li>
    <li>
      <a href="/settings/notifications" class="card flex items-center justify-between p-4">
        <span class="font-semibold text-neutral-100">Notifications</span>
        <span class="text-neutral-500">&rarr;</span>
      </a>
    </li>
    <li>
      <a href="/settings/connections" class="card flex items-center justify-between p-4">
        <span class="font-semibold text-neutral-100">Account connections</span>
        <span class="text-neutral-500">&rarr;</span>
      </a>
    </li>
    <li x-show="userId">
      <a :href="`/profile?id=${userId}`" class="card flex items-center justify-between p-4">
        <span class="font-semibold text-neutral-100">Preview my profile</span>
        <span class="text-neutral-500">&rarr;</span>
      </a>
    </li>
    <li>
      <button type="button" class="card flex w-full items-center justify-between p-4 text-left" @click="logout()">
        <span class="font-semibold text-neutral-100">Log out</span>
      </button>
    </li>
  </ul>

  <script type="module">
    import { createSettingsApp } from '/settings.js';
    import { mountHeader, mountNav } from '/nav.js';
    mountHeader();
    mountNav();

    window.settingsApp = createSettingsApp;
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <div id="wl-nav-root"></div>
</body>
</html>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/public/settings.test.ts`
Expected: PASS (5/5)

- [ ] **Step 6: Run the full suite and type-check**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all green, zero errors. This is the point where the old monolithic behavior is fully gone — confirm nothing else in the app links to the old single-page structure by searching for stale references:

```bash
grep -rn "hasSpotify\|pushSupported\|maxDistanceKm" public/settings.js public/settings.html
```

Expected: no output (none of that state/logic remains in the hub).

- [ ] **Step 7: Manually verify in a browser**

Run: `npx wrangler dev`. Visit `/settings` — confirm it's now a 6-row list menu. Tap each of the four section rows and confirm each sub-page loads its correct content and the "← Settings" link returns to the hub. Confirm the bottom nav's Settings icon stays highlighted throughout. Tap "Preview my profile" and "Log out" and confirm both still work exactly as before.

- [ ] **Step 8: Commit**

```bash
git add public/settings.html public/settings.js test/public/settings.test.ts
git commit -m "feat: rewrite Settings as a list-menu hub linking to the new sub-pages"
```
