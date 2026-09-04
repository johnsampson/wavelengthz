import { api } from '../app.js';
import { showErrorToast } from '../toast.js';

export function createInvitesApp() {
  return {
    /** @type {Array<{code: string, targetGender: string | null, redeemed: boolean, redeemedByName: string | null}> | null} */
    invites: null,
    error: null,
    loading: true,
    copiedCode: null,
    // Issue #173 (Round 8): only true for the three allowlisted invite-admin
    // accounts (src/lib/inviteCodes.ts's isInviteAdmin) -- everyone else never
    // sees the mint panel at all, not just a disabled version of it.
    canMintUnlimited: false,
    mintCount: 20,
    minting: false,

    async init() {
      try {
        const res = await api.myInvites();
        this.invites = res.invites;
        this.canMintUnlimited = !!res.canMintUnlimited;
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

    // Issue #173 (Round 8): "drop N new codes at a time -- think social
    // media campaign on X." Prepends the freshly minted codes onto the
    // existing list client-side rather than re-fetching -- the server
    // already told us exactly what it created.
    async mintCodes() {
      const count = Number(this.mintCount);
      if (!Number.isInteger(count) || count <= 0) {
        showErrorToast('Enter a positive number of codes.');
        return;
      }
      this.minting = true;
      try {
        const res = await api.mintInvites(count);
        const minted = res.codes.map((code) => ({ code, targetGender: null, redeemed: false, redeemedByName: null }));
        this.invites = [...minted, ...(this.invites ?? [])];
      } catch (e) {
        showErrorToast('Could not mint codes. Please try again.');
      } finally {
        this.minting = false;
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
