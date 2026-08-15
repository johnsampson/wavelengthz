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
