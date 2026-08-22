import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMessagesApp } from '../../public/messages.js';
import { showErrorToast } from '../../public/toast.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

// messages.js reads window.location.search at object-construction time, and
// init() touches `document` (hidden/addEventListener) -- both stubbed here
// the same way match.test.ts stubs window.
function fakeWindow() {
  return { location: { search: '?matchId=m1', href: '' }, AudioContext: undefined, webkitAudioContext: undefined };
}

function fakeDocument() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    hidden: false,
    addEventListener: vi.fn((type: string, handler: () => void) => {
      (listeners[type] ??= []).push(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
    }),
    getElementById: vi.fn(() => null),
    _listeners: listeners,
  };
}

function stubApi(handler: (path: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => handler(path)));
}

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('messages thread', () => {
  it('loads the match name and messages on init, then starts polling', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/matches/m1') return new Response(JSON.stringify({ match: { otherDisplayName: 'Sam' } }), { status: 200 });
      if (path === '/api/matches/m1/messages') return new Response(JSON.stringify({ messages: [{ id: 'msg1', sender_id: 'u2', body: 'hi' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createMessagesApp();

    await app.init();

    expect(app.otherName).toBe('Sam');
    expect(app.messages).toEqual([{ id: 'msg1', sender_id: 'u2', body: 'hi' }]);
    expect(app.pollTimer).not.toBeNull();
    app.destroy();
  });

  it('destroy() stops the poll interval and removes the audio-unlock listeners', async () => {
    const doc = fakeDocument();
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', doc);
    let pollCount = 0;
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/matches/m1') return new Response(JSON.stringify({ match: {} }), { status: 200 });
      if (path === '/api/matches/m1/messages') {
        pollCount++;
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const app = createMessagesApp();
    await app.init();
    expect(doc._listeners['pointerdown']?.length).toBe(1);

    app.destroy();
    const countAtDestroy = pollCount;
    await vi.advanceTimersByTimeAsync(10000);

    expect(pollCount).toBe(countAtDestroy); // no further polls fired after destroy()
    expect(doc._listeners['pointerdown']?.length).toBe(0);
    expect(doc._listeners['keydown']?.length).toBe(0);
  });

  // init() calls initTrackPicker() (public/trackPicker.js), which subscribes
  // to playerBar.js's now-playing changes so this thread's shared-track rows
  // stay in sync with radio auto-advancing elsewhere. destroy() must also
  // unsubscribe that -- trackPicker.js's own destroyTrackPicker() isn't
  // named plain destroy() precisely because this app defines its own, which
  // would otherwise silently override it via the mixin spread.
  it('destroy() also unsubscribes the track picker\'s now-playing listener', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/matches/m1') return new Response(JSON.stringify({ match: {} }), { status: 200 });
      if (path === '/api/matches/m1/messages') return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createMessagesApp();
    await app.init();
    expect(typeof (app as any).unsubscribeNowPlaying).toBe('function');

    app.destroy();

    expect((app as any).unsubscribeNowPlaying).toBeNull();
  });

  it('rejects a message containing a disallowed character without calling the API', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = createMessagesApp();
    app.draft = 'hello <script>';

    await app.send();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('letters, numbers'));
  });

  it('growls a specific toast when the profile is incomplete', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'profile_incomplete' }), { status: 403 })));
    const app = createMessagesApp();
    app.draft = 'hello there';

    await app.send();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('Messaging'));
  });
});

describe('scrollToBottom', () => {
  /** Minimal stand-in for the <ul> and its album-art <img> children. */
  function fakeList(images: Array<{ complete: boolean }> = []) {
    const imgs = images.map((i) => ({
      ...i,
      _handlers: [] as Array<() => void>,
      addEventListener(_type: string, fn: () => void) {
        this._handlers.push(fn);
      },
      fireLoad() {
        this._handlers.forEach((h) => h());
      },
    }));
    return { scrollTop: 0, scrollHeight: 2000, querySelectorAll: () => imgs, _imgs: imgs };
  }

  it('pins the list to the bottom', () => {
    const list = fakeList();
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { ...fakeDocument(), getElementById: vi.fn(() => list) });
    const app = createMessagesApp();

    app.scrollToBottom();

    expect(list.scrollTop).toBe(2000);
  });

  // Regression: a shared track's album art has no intrinsic height until it
  // loads, so the list grew after the initial scroll and the newest message
  // ended up below the fold.
  it('re-pins once a not-yet-loaded album image finishes loading', () => {
    const list = fakeList([{ complete: false }]);
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { ...fakeDocument(), getElementById: vi.fn(() => list) });
    const app = createMessagesApp();

    app.scrollToBottom();
    list.scrollHeight = 2600; // image loaded, list got taller
    list._imgs[0].fireLoad();

    expect(list.scrollTop).toBe(2600);
  });

  it('does not attach a listener to an already-loaded image', () => {
    const list = fakeList([{ complete: true }]);
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { ...fakeDocument(), getElementById: vi.fn(() => list) });
    const app = createMessagesApp();

    app.scrollToBottom();

    expect(list._imgs[0]._handlers).toHaveLength(0);
  });

  it('is a safe no-op when the list is not in the DOM', () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { ...fakeDocument(), getElementById: vi.fn(() => null) });
    const app = createMessagesApp();

    expect(() => app.scrollToBottom()).not.toThrow();
  });
});
