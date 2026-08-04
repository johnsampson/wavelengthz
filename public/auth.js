// Shared client-side auth check. There's no server-side session check on the
// static HTML pages themselves (they're served as plain static assets by
// Workers Assets) -- only the API routes enforce auth -- so every page that
// needs to know "is anyone logged in" asks /api/me and interprets a 401 as
// logged-out rather than a real error.
import { api } from './app.js';

export async function getAuthedUser() {
  try {
    const res = await api.me();
    return res.user;
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

// Side-effecting: redirects to /login when logged out. Used by pages that
// have no meaningful logged-out state (history, matches, settings,
// messages, onboarding) -- unlike the deck, which shows a login button
// instead of redirecting since it doubles as the logged-out landing page.
export async function requireAuth() {
  const user = await getAuthedUser();
  if (!user) {
    window.location.href = '/login';
    return null;
  }
  return user;
}
