import { api } from '../app.js';

export function createInvitesApp() {
  return {
    /** @type {Array<{code: string, targetGender: string | null, redeemed: boolean, redeemedByName: string | null}> | null} */
    invites: null,
    error: null,
    loading: true,
    copiedCode: null,

    async init() {
      try {
        const res = await api.myInvites();
        this.invites = res.invites;
      } catch (e) {
        if (e.status === 401) {
          window.location.href = '/login';
          return;
        }
        this.error = 'Could not load your invites. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    get unredeemed() {
      return (this.invites ?? []).filter((i) => !i.redeemed);
    },

    get redeemed() {
      return (this.invites ?? []).filter((i) => i.redeemed);
    },

    inviteUrl(code) {
      return `${window.location.origin}/join?code=${code}`;
    },

    genderLabel(targetGender) {
      return targetGender === 'male' ? 'a man' : targetGender === 'female' ? 'a woman' : 'anyone';
    },

    async copyLink(code) {
      try {
        await navigator.clipboard.writeText(this.inviteUrl(code));
        this.copiedCode = code;
        setTimeout(() => {
          if (this.copiedCode === code) this.copiedCode = null;
        }, 2000);
      } catch (e) {
        // Clipboard API can be unavailable (older Safari, insecure context) --
        // the link is still visible/selectable on the page, so this is a
        // silent no-op rather than an error toast for a nice-to-have.
      }
    },
  };
}
