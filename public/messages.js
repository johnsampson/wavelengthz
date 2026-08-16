import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';
import { createTrackPicker } from './trackPicker.js';

// Extracted from messages.html's inline script -- see matches.js's comment
// for why (same reasoning, same shape). Also adds destroy(), a NEW
// requirement the router introduces: without it, every navigation into and
// out of /messages via the router would start another 3s poll interval
// (and another pair of one-shot audio-unlock listeners) on top of the last,
// since nothing previously tore them down -- harmless under the old
// full-reload-per-navigation model (a real reload always killed them for
// free), but a genuine leak once the router keeps this module's page alive
// across navigations. router.js's navigate() calls this via
// `Alpine.$data(oldRoot)?.destroy?.()` on the way out of any page that
// defines it.
export function createMessagesApp() {
  const matchId = new URLSearchParams(window.location.search).get('matchId');
  return {
    // Song sharing + the running shared playlist, identical here and in
    // group.js -- see public/trackPicker.js.
    ...createTrackPicker({
      share: (track, body) => api.shareTrack(matchId, track, body),
      loadPlaylist: () => api.matchPlaylist(matchId),
    }),
    matchId,
    messages: [],
    draft: '',
    error: null,
    myId: null,
    otherName: '',
    pollTimer: null,
    audioCtx: null,
    // Bound references so destroy() can remove exactly the listeners init()
    // added, even though they're one-shot ({once: true}) and may have
    // already fired and self-removed by the time destroy() runs.
    unlockAudioHandler: null,
    // Client-side mirror of src/lib/messageRecall.ts's RECALL_WINDOW_MS --
    // only governs whether the Recall button shows; the server is still the
    // authority (a stale button click just surfaces an error).
    recallWindowMs: 15000,
    now: Date.now(),

    async init() {
      if (!(await requireAuth())) return;
      try {
        const [me, matchRes] = await Promise.all([api.me(), api.matchDetail(this.matchId)]);
        this.myId = me.user.id;
        this.otherName = matchRes.match.otherDisplayName || 'Wavelengthz user';
      } catch (e) {
        // Non-fatal -- messages themselves still load and render (just
        // without the sender label/alignment) even if this fails.
      }
      await this.load();
      this.initTrackPicker();
      await this.refreshPlaylist();
      this.scrollToBottom();
      // No WebSocket/Durable-Object infrastructure in this app -- short
      // polling is the simplest way to approximate "live" without a bigger
      // architecture change. 3s feels responsive while staying well under
      // the general API rate limit (120 req/min/IP; this is 20). Paused
      // while the tab isn't visible (see poll()).
      this.pollTimer = setInterval(() => this.poll(), 3000);
      // Browsers suspend a fresh AudioContext until a real user gesture
      // happens -- unlock it on the first tap/keypress on this page so a
      // later poll-triggered sound (with no gesture of its own) can
      // actually play. Harmless if the user never interacts before a
      // notification would fire; it just stays silent that once.
      this.unlockAudioHandler = () => this.ensureAudioContext()?.resume();
      document.addEventListener('pointerdown', this.unlockAudioHandler, { once: true });
      document.addEventListener('keydown', this.unlockAudioHandler, { once: true });
    },

    destroy() {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      if (this.unlockAudioHandler) {
        document.removeEventListener('pointerdown', this.unlockAudioHandler);
        document.removeEventListener('keydown', this.unlockAudioHandler);
        this.unlockAudioHandler = null;
      }
    },

    async load() {
      this.error = null;
      try {
        const res = await api.messages(this.matchId);
        this.messages = res.messages;
      } catch (e) {
        this.error = 'Could not load messages. Please try again.';
      }
    },

    async poll() {
      // Silent on failure, and skipped while the tab is hidden -- a
      // background refresh shouldn't interrupt an active conversation with
      // an error banner over a transient blip, or waste requests on a tab
      // nobody's looking at.
      if (document.hidden) return;
      this.now = Date.now(); // re-evaluates canRecall()'s x-show each tick
      try {
        const res = await api.messages(this.matchId);
        const grew = res.messages.length > this.messages.length;
        // A recall doesn't change the message count -- it flips recalledAt
        // on an already-known row -- so length alone missed it entirely for
        // the other participant (the sender already sees their own recall
        // optimistically, in recall() below).
        const recalledChanged = res.messages.some((m) => {
          const existing = this.messages.find((x) => x.id === m.id);
          return existing && existing.recalledAt !== m.recalledAt;
        });
        if (grew) {
          const arrived = res.messages.slice(this.messages.length);
          this.messages = res.messages;
          this.$nextTick(() => this.scrollToBottom());
          // Only for messages from the other person -- never alert on one's
          // own message showing up (e.g. sent from another tab).
          if (arrived.some((m) => m.sender_id !== this.myId)) this.notifyNewMessage();
        } else if (recalledChanged || res.messages.length !== this.messages.length) {
          this.messages = res.messages;
        }
      } catch (e) {
        // Ignore -- the next tick retries.
      }
    },

    // Always-on for now -- good candidates for a future notification
    // settings toggle (sound/vibrate on or off) once one exists.
    notifyNewMessage() {
      this.playNotificationSound();
      // No-op on browsers/platforms without the Vibration API -- notably
      // iOS Safari, which has never implemented it.
      if (navigator.vibrate) navigator.vibrate(200);
    },

    ensureAudioContext() {
      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.audioCtx = new AudioCtx();
      }
      return this.audioCtx;
    },

    playNotificationSound() {
      // Synthesized rather than a shipped audio file -- a short two-tone
      // beep needs no asset, no CSP media-src change, and no network
      // request.
      const ctx = this.ensureAudioContext();
      if (!ctx) return;
      try {
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        [880, 1174.66].forEach((freq, i) => {
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          oscillator.connect(gain);
          gain.connect(ctx.destination);
          oscillator.type = 'sine';
          oscillator.frequency.value = freq;
          const start = now + i * 0.12;
          gain.gain.setValueAtTime(0.001, start);
          gain.gain.exponentialRampToValueAtTime(0.15, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
          oscillator.start(start);
          oscillator.stop(start + 0.22);
        });
      } catch (e) {
        // Sound is a nice-to-have -- an autoplay restriction or an
        // unsupported browser must not break message polling.
      }
    },

    scrollToBottom() {
      const list = document.getElementById('message-list');
      if (list) list.scrollTop = list.scrollHeight;
    },

    canRecall(message) {
      return message.sender_id === this.myId && !message.recalledAt && this.now - message.created_at < this.recallWindowMs;
    },

    async recall(message) {
      this.error = null;
      try {
        await api.recallMessage(this.matchId, message.id);
        message.recalledAt = Date.now();
      } catch (e) {
        showErrorToast('Could not recall that message. Please try again.');
      }
    },

    async send() {
      const trimmed = this.draft.trim();
      if (!trimmed) return;
      this.error = null;
      // Cheap client-side charset pre-check for instant feedback -- the
      // profanity blocklist only lives server-side (src/lib/messageFilter.ts
      // isn't importable from a static asset page), so the server call
      // below is still the authoritative check either way. Must stay in
      // sync with src/lib/messageFilter.ts's ALLOWED_CHARS_RE.
      if (!/^[-A-Za-z0-9 .,!?']*$/.test(trimmed)) {
        showErrorToast('Messages can only contain letters, numbers, spaces, and basic punctuation ( . , ! ? \' ).');
        return;
      }
      try {
        await api.sendMessage(this.matchId, trimmed);
        this.draft = '';
        this.now = Date.now();
        await this.load();
        this.$nextTick(() => this.scrollToBottom());
      } catch (e) {
        if (e.status === 400 && e.body?.error === 'invalid_message') {
          showErrorToast("That message isn't allowed. Please rephrase it.");
        } else if (e.status === 403 && e.body?.error === 'profile_incomplete') {
          showErrorToast('Finish setting up messaging in Settings → Messaging before sending.');
        } else {
          showErrorToast('Could not send that message. Please try again.');
        }
      }
    },
  };
}
