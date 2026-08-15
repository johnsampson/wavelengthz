import { api } from './app.js';
import { requireAuth } from './auth.js';

// Extracted from notifications.html's inline script -- see matches.js's
// comment for why (same reasoning, same shape).
export function createNotificationsApp() {
  return {
    notifications: [],
    error: null,

    async init() {
      if (!(await requireAuth())) return;
      try {
        const res = await api.notifications();
        this.notifications = res.notifications;
      } catch (e) {
        this.error = 'Could not load your notifications. Please try again.';
      }
    },

    async open(n) {
      if (!n.readAt) {
        try {
          await api.markNotificationRead(n.id);
          n.readAt = Date.now();
        } catch (e) {
          // Non-fatal -- still navigate even if marking read failed.
        }
      }
      if (n.matchId) window.location.href = `/match?id=${n.matchId}`;
    },
  };
}
