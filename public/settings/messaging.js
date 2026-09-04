import { api } from '../app.js';
import { showErrorToast } from '../toast.js';

// Loose client-side normalization, purely for UX (avoids a round-trip on
// obviously-US-shaped input) -- src/routes/phone.ts's E164_RE and Twilio's
// own Lookup are the real validation, unchanged by whatever this produces.
// A leading '+' is taken as "already E.164, just strip stray formatting
// characters"; anything else is assumed a 10-digit US number and gets +1
// prepended. International numbers without a '+' aren't guessable from
// digits alone, so this app has no non-US-number path yet -- a user outside
// the US has to type their own '+' country code.
export function normalizePhoneNumber(input) {
  const trimmed = (input ?? '').trim();
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '');
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+1${digits}` : '';
}

export function createMessagingApp() {
  return {
    loading: true,
    error: null,
    ready: false,
    bio: { met: false, length: 0, required: 20 },
    photos: { met: false, count: 0, required: 3 },
    artistsActed: { met: false, count: 0, required: 50 },
    phone: { met: false, phoneNumber: null },
    // Issue #173 (Round 8): independent acknowledgement of each policy page.
    guidelines: { met: false },
    safetyTips: { met: false },

    // Phone verification's own local flow state -- entirely separate from
    // the `phone` status object above, which only reflects what's actually
    // persisted server-side.
    phoneStep: 'entry', // 'entry' | 'code' -- irrelevant once phone.met is true
    phoneInput: '',
    codeInput: '',
    // @type {string|null} -- the E.164 number a code was actually sent to.
    // Annotated (not just `null`) so TS doesn't infer the narrow literal
    // type `null` from this initializer and reject the real string this
    // gets assigned in sendCode() -- allowJs's inference reaches into this
    // file from every .ts test that imports it, even without checkJs.
    pendingPhoneNumber: /** @type {string|null} */ (null),
    sendingCode: false,
    verifyingCode: false,
    /** @type {string|null} */
    phoneInfo: null,

    async init() {
      try {
        const status = await api.messagingStatus();
        this.ready = status.ready;
        this.bio = status.bio;
        this.photos = status.photos;
        this.artistsActed = status.artistsActed;
        this.phone = status.phone;
        this.guidelines = status.guidelines;
        this.safetyTips = status.safetyTips;
      } catch (e) {
        if (e.status === 401) {
          window.location.href = '/login';
          return;
        }
        this.error = 'Could not load your messaging status. Please reload the page.';
      } finally {
        this.loading = false;
      }
    },

    async sendCode() {
      this.phoneInfo = null;
      const normalized = normalizePhoneNumber(this.phoneInput);
      if (!normalized || normalized.length < 8) {
        showErrorToast('Enter a valid phone number.');
        return;
      }
      this.sendingCode = true;
      try {
        await api.startPhoneVerification(normalized);
        this.pendingPhoneNumber = normalized;
        this.phoneStep = 'code';
        this.phoneInfo = 'Code sent. Check your texts.';
      } catch (e) {
        if (e.status === 429) {
          showErrorToast("You've tried too many times. Wait a minute and try again.");
        } else if (e.body?.error === 'voip_not_allowed') {
          showErrorToast("That number can't be verified -- Wavelengthz doesn't accept VOIP numbers.");
        } else if (e.body?.error === 'invalid_phone_number') {
          showErrorToast("That doesn't look like a valid phone number.");
        } else {
          showErrorToast('Could not send a code. Please try again.');
        }
      } finally {
        this.sendingCode = false;
      }
    },

    async verifyCode() {
      if (!this.codeInput.trim()) {
        showErrorToast('Enter the code you were sent.');
        return;
      }
      this.verifyingCode = true;
      try {
        await api.checkPhoneVerification(this.pendingPhoneNumber, this.codeInput.trim());
        this.phone = { met: true, phoneNumber: this.pendingPhoneNumber };
        this.phoneInfo = null;
        this.codeInput = '';
        this.recomputeReady();
      } catch (e) {
        if (e.body?.error === 'phone_already_verified') {
          showErrorToast('That number is already verified on a different account.');
        } else if (e.body?.error === 'invalid_code') {
          showErrorToast('That code is incorrect or expired.');
        } else {
          showErrorToast('Could not verify that code. Please try again.');
        }
      } finally {
        this.verifyingCode = false;
      }
    },

    // Lets someone fix a typo'd number without waiting out the rate limit
    // on a fresh page load -- back to the entry step, same input field.
    editPhoneNumber() {
      this.phoneStep = 'entry';
      this.phoneInfo = null;
      this.codeInput = '';
    },

    recomputeReady() {
      this.ready = this.bio.met && this.photos.met && this.artistsActed.met && this.phone.met && this.guidelines.met && this.safetyTips.met;
    },
  };
}
