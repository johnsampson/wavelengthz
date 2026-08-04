import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, getActiveTab, getNavItemsWithActive, renderNavHtml } from '../../public/nav.js';

describe('NAV_ITEMS', () => {
  it('has exactly the four top-level destinations', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(['/', '/history', '/matches', '/settings']);
  });
});

describe('getActiveTab', () => {
  it('matches each of the four tabs by exact path', () => {
    expect(getActiveTab('/')).toBe('/');
    expect(getActiveTab('/history')).toBe('/history');
    expect(getActiveTab('/matches')).toBe('/matches');
    expect(getActiveTab('/settings')).toBe('/settings');
  });

  it('returns null for a page that is not one of the four tabs', () => {
    expect(getActiveTab('/messages')).toBeNull();
    expect(getActiveTab('/onboarding')).toBeNull();
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
