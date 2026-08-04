// Shared header (wordmark) and bottom tab bar, injected client-side into
// every page except onboarding.html (a one-time gate, not a destination to
// navigate back to). There's no server-side templating in this app -- pages
// are served as plain static files -- so this keeps the actual markup and
// active-tab logic in one place instead of duplicated (and inevitably
// drifting) across six separate HTML files.

const ICONS = {
  '/':
    '<path d="M12 3c2 3-1 4-1 7a4 4 0 0 0 8 0c0-1-.3-2-.7-2.7.9.4 2.7 2 2.7 5.7a7 7 0 1 1-14 0c0-4 2.5-6.3 5-10z" />',
  '/history': '<circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" />',
  '/matches': '<path d="M12 21C2 15 2 10 3 7L7 11L12 7L17 11L21 7C22 10 22 15 12 21Z" />',
  '/settings':
    '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />',
};

export const NAV_ITEMS = [
  { href: '/', label: 'Deck' },
  { href: '/history', label: 'History' },
  { href: '/matches', label: 'Matches' },
  { href: '/settings', label: 'Settings' },
];

export function getActiveTab(pathname) {
  const item = NAV_ITEMS.find((i) => i.href === pathname);
  return item ? item.href : null;
}

export function getNavItemsWithActive(pathname) {
  const active = getActiveTab(pathname);
  return NAV_ITEMS.map((item) => ({ ...item, active: item.href === active }));
}

export function renderNavHtml(pathname) {
  const items = getNavItemsWithActive(pathname);
  const links = items
    .map(
      (item) => `
        <a
          href="${item.href}"
          class="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs transition ${
            item.active ? 'font-semibold text-white' : 'font-medium text-neutral-500'
          }"
          ${item.active ? 'aria-current="page"' : ''}
        >
          <svg
            class="h-6 w-6 ${item.active ? 'text-brand-400' : 'text-neutral-500'}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >${ICONS[item.href] || ''}</svg>
          ${item.label}
        </a>`
    )
    .join('');
  return `
    <nav
      class="fixed inset-x-0 bottom-0 z-10 flex border-t border-white/10 bg-surface/90 backdrop-blur-lg"
      style="padding-bottom: env(safe-area-inset-bottom)"
      aria-label="Main navigation"
    >${links}</nav>`;
}

export function renderHeaderHtml() {
  return `
    <header class="flex items-center justify-center gap-1.5 p-4">
      <a href="/" class="wordmark text-xl">Wavelengthz</a>
    </header>`;
}

// Side-effecting: finds the placeholder elements this module expects each
// page to include, and fills them in. A no-op if a page omits one (so
// index.html, which builds its own header around the mode toggle, can skip
// the header placeholder while still getting the nav).
export function mountNav(pathname = window.location.pathname) {
  const root = document.getElementById('wl-nav-root');
  if (root) root.innerHTML = renderNavHtml(pathname);
}

export function mountHeader() {
  const root = document.getElementById('wl-header-root');
  if (root) root.innerHTML = renderHeaderHtml();
}
