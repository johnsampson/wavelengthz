// Issue #173 (Round 8): "give the report and block functionality the 'why'
// w/ an 'other' text field option." Shared by match.js (report + block) and
// personProfile.js (report only) -- same mixin pattern as trackPicker.js
// (spread into a host app's own object), except the host defines its own
// `reasonDialogSubmit(mode, reason, details)` regular method rather than
// this module taking callbacks at construction time: `match`/`userId` on
// the host app are only populated later by its own init(), so a closure
// captured here at construction couldn't see them -- a method the host
// defines is invoked with `this` bound to the live Alpine component
// instead, same as init()/report()/etc. already are.
//
// `reason` must be one of REASON_OPTIONS' values, matching
// src/routes/safety.ts's VALID_REASONS exactly (kept in sync by hand --
// small, stable, fixed set on both sides).
export const REASON_OPTIONS = [
  { value: 'inappropriate_photos', label: 'Inappropriate photos' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'fake_profile', label: 'Fake profile' },
  { value: 'spam', label: 'Spam' },
  { value: 'underage', label: 'Underage' },
  { value: 'other', label: 'Other' },
];

export function createReasonDialog() {
  return {
    reasonDialogOpen: false,
    /** @type {'report' | 'block' | null} */
    reasonDialogMode: null,
    reasonDialogChoice: null,
    reasonDialogOtherText: '',
    reasonDialogSubmitting: false,
    reasonDialogOptions: REASON_OPTIONS,

    openReportDialog() {
      this.reasonDialogMode = 'report';
      this.reasonDialogChoice = null;
      this.reasonDialogOtherText = '';
      this.reasonDialogOpen = true;
    },

    // Block never requires a reason (Terms of Service §6 -- "entirely your
    // own choice") -- this dialog offers one, it doesn't gate the action on
    // picking one. See skipReasonDialog().
    openBlockDialog() {
      this.reasonDialogMode = 'block';
      this.reasonDialogChoice = null;
      this.reasonDialogOtherText = '';
      this.reasonDialogOpen = true;
    },

    closeReasonDialog() {
      this.reasonDialogOpen = false;
    },

    selectReasonDialogChoice(value) {
      this.reasonDialogChoice = value;
    },

    // Block-only: proceeds with no reason/details at all.
    async skipReasonDialog() {
      if (this.reasonDialogMode !== 'block' || this.reasonDialogSubmitting) return;
      this.reasonDialogSubmitting = true;
      try {
        await this.reasonDialogSubmit('block', undefined, undefined);
      } finally {
        this.reasonDialogSubmitting = false;
      }
    },

    async confirmReasonDialog() {
      if (!this.reasonDialogChoice || this.reasonDialogSubmitting) return;
      const details = this.reasonDialogChoice === 'other' ? this.reasonDialogOtherText.trim() : undefined;
      if (this.reasonDialogChoice === 'other' && !details) return;
      this.reasonDialogSubmitting = true;
      try {
        await this.reasonDialogSubmit(this.reasonDialogMode, this.reasonDialogChoice, details);
      } finally {
        this.reasonDialogSubmitting = false;
      }
    },

    // Not implemented here on purpose -- the host app owns the actual API
    // call (and whatever happens after: navigating away on a successful
    // block, showing an error toast on failure) and must call
    // this.closeReasonDialog() itself on success. Left open on failure so
    // the dialog's own error state (a toast, typically) stays visible and
    // the choice/text the member already entered isn't lost.
    async reasonDialogSubmit(_mode, _reason, _details) {
      throw new Error('reasonDialogSubmit must be implemented by the host app');
    },
  };
}
