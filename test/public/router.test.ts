import { describe, it, expect } from 'vitest';
import { ROUTES, BYPASS_PATHS, resolveRoute, shouldInterceptClick } from '../../public/router.js';

// Every field shouldInterceptClick checks, defaulted to "should intercept" --
// individual tests override just the one field they're exercising, matching
// this repo's existing pure-function test style (e.g. search.js's tests).
function baseOpts(overrides = {}) {
  return {
    pathname: '/settings',
    sameOrigin: true,
    targetAttr: '',
    rel: '',
    hasDownloadAttr: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe('ROUTES', () => {
  it('has an entry for every currently-routed page', () => {
    expect(Object.keys(ROUTES).sort()).toEqual([
      '/',
      '/artist',
      '/group',
      '/groups',
      '/history',
      '/match',
      '/matches',
      '/messages',
      '/notifications',
      '/profile',
      '/settings',
      '/settings/connections',
      '/settings/messaging',
      '/settings/notifications',
      '/settings/preferences',
      '/settings/profile',
      '/wavelength',
    ]);
  });
});

describe('resolveRoute', () => {
  it('resolves a routed pathname to its module/factory', () => {
    expect(resolveRoute('/settings')).toEqual({ module: '/settings.js', factory: 'createSettingsApp' });
    expect(resolveRoute('/history')).toEqual({ module: '/history.js', factory: 'createHistoryApp' });
    expect(resolveRoute('/')).toEqual({ module: '/index.js', factory: 'createDeckApp' });
    expect(resolveRoute('/artist')).toEqual({ module: '/artist.js', factory: 'createArtistApp' });
    expect(resolveRoute('/profile')).toEqual({ module: '/personProfile.js', factory: 'createPersonProfileApp' });
    expect(resolveRoute('/settings/profile')).toEqual({ module: '/settings/profile.js', factory: 'createProfileApp' });
  });

  it('returns null for a pathname not yet migrated onto the router', () => {
    expect(resolveRoute('/onboarding')).toBeNull();
    // /settings/messaging matches exactly, but a made-up deeper path under it
    // does not -- resolveRoute is an exact-match table, no prefix matching
    // like nav.js's getActiveTab.
    expect(resolveRoute('/settings/messaging/extra')).toBeNull();
  });
});

describe('shouldInterceptClick', () => {
  it('intercepts a plain primary click on a routed same-origin link', () => {
    expect(shouldInterceptClick(baseOpts())).toBe(true);
  });

  it('does not intercept a non-primary click (middle/right click)', () => {
    expect(shouldInterceptClick(baseOpts({ button: 1 }))).toBe(false);
  });

  it('does not intercept when any modifier key is held', () => {
    expect(shouldInterceptClick(baseOpts({ metaKey: true }))).toBe(false);
    expect(shouldInterceptClick(baseOpts({ ctrlKey: true }))).toBe(false);
    expect(shouldInterceptClick(baseOpts({ shiftKey: true }))).toBe(false);
    expect(shouldInterceptClick(baseOpts({ altKey: true }))).toBe(false);
  });

  it('does not intercept a cross-origin link', () => {
    expect(shouldInterceptClick(baseOpts({ sameOrigin: false }))).toBe(false);
  });

  it('does not intercept target="_blank"', () => {
    expect(shouldInterceptClick(baseOpts({ targetAttr: '_blank' }))).toBe(false);
  });

  it('does not intercept rel="external"', () => {
    expect(shouldInterceptClick(baseOpts({ rel: 'external' }))).toBe(false);
  });

  it('does not intercept a download link', () => {
    expect(shouldInterceptClick(baseOpts({ hasDownloadAttr: true }))).toBe(false);
  });

  it('does not intercept an already-handled click', () => {
    expect(shouldInterceptClick(baseOpts({ defaultPrevented: true }))).toBe(false);
  });

  it('does not intercept a bypassed OAuth/session path', () => {
    for (const pathname of BYPASS_PATHS) {
      expect(shouldInterceptClick(baseOpts({ pathname }))).toBe(false);
    }
  });

  it('does not intercept a pathname that is not yet routed', () => {
    expect(shouldInterceptClick(baseOpts({ pathname: '/onboarding' }))).toBe(false);
  });
});
