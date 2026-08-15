import { api } from './app.js';
import { requireAuth } from './auth.js';
import { showErrorToast } from './toast.js';

// Extracted from group.html's inline script -- see messages.js's comment
// for why this carries a destroy() too (same poll-interval/audio-unlock
// leak risk, same fix).
export function createGroupApp() {
  return {
    groupId: new URLSearchParams(window.location.search).get('id'),
    /** @type {{id: string, name: string, topic?: string, members: Array<{id: string, displayName?: string}>} | null} */
    group: null,
    messages: [],
    draft: '',
    error: null,
    myId: null,
    pollTimer: null,
    audioCtx: null,
    unlockAudioHandler: null,
    recallWindowMs: 15000,
    now: Date.now(),

    async init() {
      const me = await requireAuth();
      if (!me) return;
      this.myId = me.id;
      try {
        const res = await api.groupDetail(this.groupId);
        this.group = res.group;
      } catch (e) {
        this.error = 'Could not load this group. Please try again.';
        return;
      }
      await this.load();
      this.scrollToBottom();
      // Same short-polling approach as public/messages.js -- no WebSocket/
      // Durable-Object infrastructure in this app. 3s stays well under the
      // general API rate limit (120 req/min/IP).
      this.pollTimer = setInterval(() => this.poll(), 3000);
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

    memberName(userId) {
      const m = this.group?.members.find((m) => m.id === userId);
      return m?.displayName || 'Someone';
    },

    async load() {
      try {
        const res = await api.groupMessages(this.groupId);
        this.messages = res.messages;
      } catch (e) {
        this.error = 'Could not load messages. Please try again.';
      }
    },

    async poll() {
      if (document.hidden) return;
      this.now = Date.now(); // re-evaluates canRecall()'s x-show each tick
      try {
        const res = await api.groupMessages(this.groupId);
        const grew = res.messages.length > this.messages.length;
        // A recall doesn't change the message count -- it flips recalledAt
        // on an already-known row -- so length alone missed it entirely for
        // other members (the sender already sees their own recall
        // optimistically, in recall() below).
        const recalledChanged = res.messages.some((m) => {
          const existing = this.messages.find((x) => x.id === m.id);
          return existing && existing.recalledAt !== m.recalledAt;
        });
        if (grew) {
          const arrived = res.messages.slice(this.messages.length);
          this.messages = res.messages;
          this.$nextTick(() => this.scrollToBottom());
          if (arrived.some((m) => m.sender_id !== this.myId)) this.notifyNewMessage();
        } else if (recalledChanged || res.messages.length !== this.messages.length) {
          this.messages = res.messages;
        }
      } catch (e) {
        // Ignore -- the next tick retries.
      }
    },

    // Always-on for now -- see public/messages.js's note on this being a
    // good future notification-settings candidate.
    notifyNewMessage() {
      this.playNotificationSound();
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
      const list = document.getElementById('group-message-list');
      if (list) list.scrollTop = list.scrollHeight;
    },

    canRecall(message) {
      return message.sender_id === this.myId && !message.recalledAt && this.now - message.created_at < this.recallWindowMs;
    },

    async recall(message) {
      this.error = null;
      try {
        await api.recallGroupMessage(this.groupId, message.id);
        message.recalledAt = Date.now();
      } catch (e) {
        showErrorToast('Could not recall that message. Please try again.');
      }
    },

    async send() {
      const trimmed = this.draft.trim();
      if (!trimmed) return;
      this.error = null;
      // Cheap client-side charset pre-check -- see public/messages.js for
      // why the profanity blocklist can't mirror here too.
      if (!/^[-A-Za-z0-9 .,!?']*$/.test(trimmed)) {
        showErrorToast("Messages can only contain letters, numbers, spaces, and basic punctuation ( . , ! ? ' ).");
        return;
      }
      try {
        await api.sendGroupMessage(this.groupId, trimmed);
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

    async leave() {
      this.error = null;
      try {
        await api.leaveGroup(this.groupId);
        window.location.href = '/groups';
      } catch (e) {
        showErrorToast('Could not leave the group. Please try again.');
      }
    },
  };
}
