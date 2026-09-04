import { describe, it, expect, vi } from 'vitest';
import { createReasonDialog, REASON_OPTIONS } from '../../public/reasonDialog.js';

// Issue #173 (Round 8): pure mixin-logic tests -- host apps (match.js,
// personProfile.js) get their own tests for how they wire
// reasonDialogSubmit into a real API call; this file only covers the
// picker's own open/select/validate/submit-dispatch behavior.

function makeHost(overrides: Record<string, any> = {}) {
  return { ...createReasonDialog(), ...overrides } as any;
}

describe('reasonDialog', () => {
  it('exposes the fixed reason set, matching src/routes/safety.ts\'s VALID_REASONS', () => {
    expect(REASON_OPTIONS.map((o) => o.value)).toEqual(['inappropriate_photos', 'harassment', 'fake_profile', 'spam', 'underage', 'other']);
  });

  it('openReportDialog resets choice/text and sets mode: report', () => {
    const host = makeHost();
    host.reasonDialogChoice = 'spam';
    host.reasonDialogOtherText = 'leftover text';

    host.openReportDialog();

    expect(host.reasonDialogOpen).toBe(true);
    expect(host.reasonDialogMode).toBe('report');
    expect(host.reasonDialogChoice).toBeNull();
    expect(host.reasonDialogOtherText).toBe('');
  });

  it('openBlockDialog resets choice/text and sets mode: block', () => {
    const host = makeHost();

    host.openBlockDialog();

    expect(host.reasonDialogOpen).toBe(true);
    expect(host.reasonDialogMode).toBe('block');
  });

  it('closeReasonDialog just hides the dialog, without touching the chosen reason', () => {
    const host = makeHost();
    host.openReportDialog();
    host.selectReasonDialogChoice('harassment');

    host.closeReasonDialog();

    expect(host.reasonDialogOpen).toBe(false);
    expect(host.reasonDialogChoice).toBe('harassment');
  });

  it('confirmReasonDialog does nothing when no reason is chosen yet', async () => {
    const reasonDialogSubmit = vi.fn();
    const host = makeHost({ reasonDialogSubmit });
    host.openReportDialog();

    await host.confirmReasonDialog();

    expect(reasonDialogSubmit).not.toHaveBeenCalled();
  });

  it('confirmReasonDialog refuses to submit "other" with no typed detail', async () => {
    const reasonDialogSubmit = vi.fn();
    const host = makeHost({ reasonDialogSubmit });
    host.openReportDialog();
    host.selectReasonDialogChoice('other');
    host.reasonDialogOtherText = '   ';

    await host.confirmReasonDialog();

    expect(reasonDialogSubmit).not.toHaveBeenCalled();
  });

  it('confirmReasonDialog submits the trimmed "other" text as details', async () => {
    const reasonDialogSubmit = vi.fn(async () => {});
    const host = makeHost({ reasonDialogSubmit });
    host.openReportDialog();
    host.selectReasonDialogChoice('other');
    host.reasonDialogOtherText = '  kept messaging me after I said stop  ';

    await host.confirmReasonDialog();

    expect(reasonDialogSubmit).toHaveBeenCalledWith('report', 'other', 'kept messaging me after I said stop');
  });

  it('confirmReasonDialog submits a fixed reason with no details', async () => {
    const reasonDialogSubmit = vi.fn(async () => {});
    const host = makeHost({ reasonDialogSubmit });
    host.openBlockDialog();
    host.selectReasonDialogChoice('spam');

    await host.confirmReasonDialog();

    expect(reasonDialogSubmit).toHaveBeenCalledWith('block', 'spam', undefined);
  });

  it('sets reasonDialogSubmitting true for the duration of the submit call, false again after -- even on failure', async () => {
    const host = makeHost();
    let submittingDuringCall: boolean | null = null;
    host.reasonDialogSubmit = vi.fn(async () => {
      submittingDuringCall = host.reasonDialogSubmitting;
      throw new Error('boom');
    });
    host.openReportDialog();
    host.selectReasonDialogChoice('spam');

    await expect(host.confirmReasonDialog()).rejects.toThrow('boom');

    expect(submittingDuringCall).toBe(true);
    expect(host.reasonDialogSubmitting).toBe(false);
  });

  it('confirmReasonDialog is a no-op while already submitting (no double-submit)', async () => {
    const reasonDialogSubmit = vi.fn(async () => {});
    const host = makeHost({ reasonDialogSubmit });
    host.openReportDialog();
    host.selectReasonDialogChoice('spam');
    host.reasonDialogSubmitting = true;

    await host.confirmReasonDialog();

    expect(reasonDialogSubmit).not.toHaveBeenCalled();
  });

  it('skipReasonDialog only works in block mode', async () => {
    const reasonDialogSubmit = vi.fn(async () => {});
    const host = makeHost({ reasonDialogSubmit });
    host.openReportDialog();

    await host.skipReasonDialog();

    expect(reasonDialogSubmit).not.toHaveBeenCalled();
  });

  it('skipReasonDialog submits with no reason/details at all', async () => {
    const reasonDialogSubmit = vi.fn(async () => {});
    const host = makeHost({ reasonDialogSubmit });
    host.openBlockDialog();

    await host.skipReasonDialog();

    expect(reasonDialogSubmit).toHaveBeenCalledWith('block', undefined, undefined);
  });

  it('the default reasonDialogSubmit throws, so a host app that forgets to implement it fails loudly', async () => {
    const host = makeHost();
    host.openBlockDialog();

    await expect(host.reasonDialogSubmit('block', undefined, undefined)).rejects.toThrow(/must be implemented/);
  });
});
