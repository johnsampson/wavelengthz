import { api } from './app.js';
import { requireAuth } from './auth.js';

// Extracted from matches.html's inline script so it can carry `x-data` on
// a genuinely-replaceable `#wl-app-root` instead of `<body>` -- see
// public/router.js's top comment for why that move is required, not just
// stylistic. Mirrors history.js/settings.js's own extraction shape.
export function createMatchesApp() {
  return {
    matches: [],
    error: null,
    async init() {
      if (!(await requireAuth())) return;
      await this.load();
    },
    async load() {
      this.error = null;
      try {
        const res = await api.matches();
        this.matches = res.matches;
      } catch (e) {
        this.error = 'Could not load your matches. Please try again.';
      }
    },
  };
}
