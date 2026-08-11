import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, getActiveTab, getNavItemsWithActive, renderNavHtml, renderHeaderHtml } from '../../public/nav.js';

describe('NAV_ITEMS', () => {
  it('has exactly the five top-level destinations', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(['/', '/history', '/matches', '/groups', '/settings']);
  });
});

describe('getActiveTab', () => {
  it('matches each of the five tabs by exact path', () => {
    expect(getActiveTab('/')).toBe('/');
    expect(getActiveTab('/history')).toBe('/history');
    expect(getActiveTab('/matches')).toBe('/matches');
    expect(getActiveTab('/groups')).toBe('/groups');
    expect(getActiveTab('/settings')).toBe('/settings');
  });

  it('returns null for a page that is not one of the five tabs', () => {
    expect(getActiveTab('/messages')).toBeNull();
    expect(getActiveTab('/onboarding')).toBeNull();
  });

  it('matches /settings for any nested settings sub-page, not just the exact path', () => {
    expect(getActiveTab('/settings/profile')).toBe('/settings');
    expect(getActiveTab('/settings/preferences')).toBe('/settings');
    expect(getActiveTab('/settings/notifications')).toBe('/settings');
    expect(getActiveTab('/settings/connections')).toBe('/settings');
  });
});

describe('getNavItemsWithActive', () => {
  it('marks exactly the current page as active, and no other', () => {
    const items = getNavItemsWithActive('/history');
    const activeHrefs = items.filter((i) => i.active).map((i) => i.href);
    expect(activeHrefs).toEqual(['/history']);
  });

  it('marks no tab active when the current page is not one of the four', () => {
    const items = getNavItemsWithActive('/messages');
    expect(items.every((i) => !i.active)).toBe(true);
  });
});

describe('renderNavHtml', () => {
  it('emits exactly one aria-current="page" when a tab is active', () => {
    const html = renderNavHtml('/history');
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });

  it('emits no aria-current when the current page is not one of the four', () => {
    const html = renderNavHtml('/messages');
    expect(html).not.toContain('aria-current="page"');
  });

  it('includes a label and link for all four tabs, with no .html extensions', () => {
    const html = renderNavHtml('/');
    for (const item of NAV_ITEMS) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(item.label);
    }
    expect(html).not.toContain('.html');
  });
});

describe('renderHeaderHtml', () => {
  it('always links the bell to /notifications', () => {
    expect(renderHeaderHtml(0)).toContain('href="/notifications"');
  });

  it('shows no unread badge when the count is zero', () => {
    const html = renderHeaderHtml(0);
    expect(html).not.toContain('data-unread-badge');
  });

  it('shows the unread count when greater than zero', () => {
    const html = renderHeaderHtml(3);
    expect(html).toContain('data-unread-badge');
    expect(html).toContain('>3<');
  });

  it('caps the displayed badge at 9+', () => {
    const html = renderHeaderHtml(15);
    expect(html).toContain('>9+<');
  });
});
