import { describe, it, expect } from 'vitest';
import { artistTracksCacheKey, readArtistTracksCache, writeArtistTracksCache } from '../../src/lib/artistTracksCache';

// A minimal in-memory stand-in for KVNamespace -- this module's only
// dependency is get/put, so a real Miniflare-backed KV binding (as used
// elsewhere via cloudflare:test's `env`) would be more setup than this
// needs.
function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  };
}

describe('artistTracksCacheKey', () => {
  it('includes both the spotify artist id and the limit, so different limits never collide', () => {
    expect(artistTracksCacheKey('sp1', 30)).not.toBe(artistTracksCacheKey('sp1', 5));
    expect(artistTracksCacheKey('sp1', 30)).not.toBe(artistTracksCacheKey('sp2', 30));
  });
});

describe('readArtistTracksCache', () => {
  it('returns null on a genuine miss', async () => {
    const kv = fakeKv();
    expect(await readArtistTracksCache(kv as any, 'sp1', 30)).toBeNull();
  });

  it('returns the parsed array on a hit', async () => {
    const tracks = [{ id: 't1', name: 'Track One' }];
    const kv = fakeKv({ [artistTracksCacheKey('sp1', 30)]: JSON.stringify(tracks) });
    expect(await readArtistTracksCache(kv as any, 'sp1', 30)).toEqual(tracks);
  });

  it('returns null (not a thrown error) when the KV read itself fails', async () => {
    const brokenKv = {
      get: async () => {
        throw new Error('KV namespace unavailable');
      },
    };
    expect(await readArtistTracksCache(brokenKv as any, 'sp1', 30)).toBeNull();
  });
});

describe('writeArtistTracksCache', () => {
  it('writes the tracks as JSON under the key both functions agree on', async () => {
    const kv = fakeKv();
    const tracks = [{ id: 't1', name: 'Track One' }];

    await writeArtistTracksCache(kv as any, 'sp1', 30, tracks);

    expect(await readArtistTracksCache(kv as any, 'sp1', 30)).toEqual(tracks);
  });

  it('does not throw when the KV write fails -- the caller already has its live-fetched result either way', async () => {
    const brokenKv = {
      put: async () => {
        throw new Error('KV namespace unavailable');
      },
    };
    await expect(writeArtistTracksCache(brokenKv as any, 'sp1', 30, [])).resolves.toBeUndefined();
  });
});
