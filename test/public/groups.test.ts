import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGroupsApp } from '../../public/groups.js';
import { showErrorToast } from '../../public/toast.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(navigate).mockClear();
});

function stubApi(handler: (path: string, options?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => handler(path, options)));
}

describe('groups list', () => {
  it('loads groups on init when authed', async () => {
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/groups') return new Response(JSON.stringify({ groups: [{ id: 'g1', name: 'Indie fans' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createGroupsApp();

    await app.init();

    expect(app.groups).toEqual([{ id: 'g1', name: 'Indie fans' }]);
    vi.unstubAllGlobals();
  });

  it('clears the create form and reloads after a successful create', async () => {
    let created = false;
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/groups' && !created) {
        created = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === '/api/groups') return new Response(JSON.stringify({ groups: [{ id: 'g1', name: 'New group' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createGroupsApp();
    app.newName = 'New group';
    app.showCreate = true;

    await app.create();

    expect(app.newName).toBe('');
    expect(app.showCreate).toBe(false);
    expect(app.groups).toEqual([{ id: 'g1', name: 'New group' }]);
    vi.unstubAllGlobals();
  });

  it('does not submit an empty group name', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = createGroupsApp();
    app.newName = '   ';

    await app.create();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows a specific toast when joining a full group', async () => {
    stubApi((path) => {
      if (path.endsWith('/join')) return new Response(JSON.stringify({ error: 'group_full' }), { status: 403 });
      return new Response('{}', { status: 200 });
    });
    const app = createGroupsApp();

    await app.join({ id: 'g1' });

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('full'));
    vi.unstubAllGlobals();
  });

  it('navigates into the group after successfully joining', async () => {
    stubApi((path) => {
      if (path.endsWith('/join')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const app = createGroupsApp();

    await app.join({ id: 'g1' });

    expect(navigate).toHaveBeenCalledWith('/group?id=g1');
    vi.unstubAllGlobals();
  });
});
