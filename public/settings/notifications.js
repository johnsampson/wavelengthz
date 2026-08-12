import { api } from '../app.js';
import { showErrorToast } from '../toast.js';

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
    emailEnabled: true,
    showIosInstallBanner: false,
    error: null,
    loading: true,

    async init() {
      try {
        // Unlike every other Settings page's "session-liveness check only"
        // comment this used to carry, this page does need the user object
        // now -- email_notifications_enabled lives on it.
        const me = await api.me();
        this.emailEnabled = me.user.email_notifications_enabled !== 0;
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
        if (e.status === 401) {
          window.location.href = '/login';
          return;
        }
        this.error = 'Could not load notification settings. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    async enablePush() {
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
        showErrorToast('Could not enable notifications. Please try again.');
      }
    },

    async disablePush() {
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
        showErrorToast('Could not disable notifications. Please try again.');
      }
    },

    dismissIosInstallBanner() {
      this.showIosInstallBanner = false;
      if (typeof localStorage !== 'undefined') localStorage.setItem('wl_ios_install_dismissed', '1');
    },

    async enableEmail() {
      const previous = this.emailEnabled;
      this.emailEnabled = true; // optimistic -- reverted below on failure
      try {
        await api.setEmailNotificationsEnabled(true);
      } catch (e) {
        this.emailEnabled = previous;
        showErrorToast('Could not enable email notifications. Please try again.');
      }
    },

    async disableEmail() {
      const previous = this.emailEnabled;
      this.emailEnabled = false;
      try {
        await api.setEmailNotificationsEnabled(false);
      } catch (e) {
        this.emailEnabled = previous;
        showErrorToast('Could not disable email notifications. Please try again.');
      }
    },
  };
}
