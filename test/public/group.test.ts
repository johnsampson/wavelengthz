import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGroupApp } from '../../public/group.js';
import { showErrorToast } from '../../public/toast.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

function fakeWindow() {
  return { location: { search: '?id=g1', href: '' }, AudioContext: undefined, webkitAudioContext: undefined };
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
  vi.mocked(navigate).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('group chat', () => {
  it('loads the group and messages on init, then starts polling', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/groups/g1') return new Response(JSON.stringify({ group: { id: 'g1', name: 'Indie fans', members: [] } }), { status: 200 });
      if (path === '/api/groups/g1/messages') return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createGroupApp();

    await app.init();

    expect(app.group?.name).toBe('Indie fans');
    expect(app.pollTimer).not.toBeNull();
    app.destroy();
  });

  it('surfaces an error and never starts polling when the group fails to load', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      return new Response('nope', { status: 500 });
    });
    const app = createGroupApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.pollTimer).toBeNull();
  });

  it('destroy() stops the poll interval and removes the audio-unlock listeners', async () => {
    const doc = fakeDocument();
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', doc);
    let pollCount = 0;
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/groups/g1') return new Response(JSON.stringify({ group: { id: 'g1', name: 'g', members: [] } }), { status: 200 });
      if (path === '/api/groups/g1/messages') {
        pollCount++;
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const app = createGroupApp();
    await app.init();
    expect(doc._listeners['keydown']?.length).toBe(1);

    app.destroy();
    const countAtDestroy = pollCount;
    await vi.advanceTimersByTimeAsync(10000);

    expect(pollCount).toBe(countAtDestroy);
    expect(doc._listeners['pointerdown']?.length).toBe(0);
    expect(doc._listeners['keydown']?.length).toBe(0);
  });

  it('navigates to /groups after successfully leaving', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', fakeDocument());
    stubApi(() => new Response('{}', { status: 200 }));
    const app = createGroupApp();

    await app.leave();

    expect(navigate).toHaveBeenCalledWith('/groups');
  });

  it('resolves a member id to their display name, falling back to "Someone"', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createGroupApp();
    app.group = { id: 'g1', name: 'g', members: [{ id: 'u2', displayName: 'Sam' }] };

    expect(app.memberName('u2')).toBe('Sam');
    expect(app.memberName('u3')).toBe('Someone');
  });
});
