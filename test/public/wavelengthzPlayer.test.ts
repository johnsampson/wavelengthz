import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkPlayerAvailability,
  getPlayer,
  playTrack,
  pausePlayback,
  resumePlayback,
  _resetForTests,
} from '../../public/wavelengthzPlayer.js';

function stubPlayerTokenFetch(response: any, extra?: (url: string, init: any) => Response | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init?: any) => {
      const s = String(url);
      if (s.includes('/api/me/player-token')) {
        return new Response(JSON.stringify(response), { status: 200 });
      }
      if (extra) {
        const res = extra(s, init);
        if (res) return res;
      }
      throw new Error(`unexpected fetch: ${s}`);
    })
  );
}

// A minimal stand-in for the real Spotify.Player -- addListener/connect are
// all this module ever touches. `fire(event, payload)` lets a test resolve
// getPlayer() down whichever path it wants (ready vs. one of the error
// events) without a real SDK connection.
function fakeSpotifyPlayer() {
  const listeners: Record<string, (payload?: any) => void> = {};
  return {
    addListener: (event: string, cb: (payload?: any) => void) => {
      listeners[event] = cb;
    },
    connect: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    fire(event: string, payload?: any) {
      listeners[event]?.(payload);
    },
  };
}

beforeEach(() => {
  _resetForTests();
});

describe('checkPlayerAvailability', () => {
  it('caches the result -- a second call does not re-fetch', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ available: false }), { status: 200 });
      })
    );

    const first = await checkPlayerAvailability();
    const second = await checkPlayerAvailability();

    expect(first).toEqual({ available: false });
    expect(second).toEqual({ available: false });
    expect(calls).toBe(1);
    vi.unstubAllGlobals();
  });

  it('resolves to available:false rather than throwing when the request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    await expect(checkPlayerAvailability()).resolves.toEqual({ available: false });
    vi.unstubAllGlobals();
  });
});

describe('getPlayer', () => {
  it('resolves to null without ever touching window.Spotify when ineligible', async () => {
    stubPlayerTokenFetch({ available: false });
    // No .Spotify property at all -- would throw if this module tried to
    // construct a player anyway.
    vi.stubGlobal('window', {});

    await expect(getPlayer()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('resolves to {player, deviceId} once the SDK fires ready', async () => {
    stubPlayerTokenFetch({ available: true, accessToken: 'tok' });
    const fakePlayer = fakeSpotifyPlayer();
    fakePlayer.connect.mockImplementation(() => fakePlayer.fire('ready', { device_id: 'dev1' }));
    vi.stubGlobal('window', { Spotify: { Player: vi.fn(function () { return fakePlayer; }) } });

    const result = await getPlayer();

    expect(result).toEqual({ player: fakePlayer, deviceId: 'dev1' });
    vi.unstubAllGlobals();
  });

  it('resolves to null when the SDK reports account_error (e.g. a non-Premium account)', async () => {
    stubPlayerTokenFetch({ available: true, accessToken: 'tok' });
    const fakePlayer = fakeSpotifyPlayer();
    fakePlayer.connect.mockImplementation(() => fakePlayer.fire('account_error'));
    vi.stubGlobal('window', { Spotify: { Player: vi.fn(function () { return fakePlayer; }) } });

    await expect(getPlayer()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('resolves to null on initialization_error and on authentication_error too', async () => {
    for (const event of ['initialization_error', 'authentication_error']) {
      _resetForTests();
      stubPlayerTokenFetch({ available: true, accessToken: 'tok' });
      const fakePlayer = fakeSpotifyPlayer();
      fakePlayer.connect.mockImplementation(() => fakePlayer.fire(event));
      vi.stubGlobal('window', { Spotify: { Player: vi.fn(function () { return fakePlayer; }) } });

      await expect(getPlayer()).resolves.toBeNull();
      vi.unstubAllGlobals();
    }
  });

  it('caches the connection -- a second call does not re-instantiate the SDK player', async () => {
    stubPlayerTokenFetch({ available: true, accessToken: 'tok' });
    const fakePlayer = fakeSpotifyPlayer();
    fakePlayer.connect.mockImplementation(() => fakePlayer.fire('ready', { device_id: 'dev1' }));
    const PlayerCtor = vi.fn(function () { return fakePlayer; });
    vi.stubGlobal('window', { Spotify: { Player: PlayerCtor } });

    await getPlayer();
    await getPlayer();

    expect(PlayerCtor).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('playTrack', () => {
  it('returns false without calling the Spotify Web API when ineligible', async () => {
    stubPlayerTokenFetch({ available: false });
    vi.stubGlobal('window', {});

    await expect(playTrack('trk1')).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it('PUTs the track uri to the Spotify Web API with the connected device id, and returns true on success', async () => {
    const fakePlayer = fakeSpotifyPlayer();
    fakePlayer.connect.mockImplementation(() => fakePlayer.fire('ready', { device_id: 'dev1' }));
    vi.stubGlobal('window', { Spotify: { Player: vi.fn(function () { return fakePlayer; }) } });

    let playCall: { url: string; init: any } | null = null;
    stubPlayerTokenFetch({ available: true, accessToken: 'tok' }, (url, init) => {
      if (url.includes('api.spotify.com/v1/me/player/play')) {
        playCall = { url, init };
        return new Response(null, { status: 204 });
      }
      return null;
    });

    await expect(playTrack('trk1')).resolves.toBe(true);
    expect(playCall!.url).toContain('device_id=dev1');
    expect(playCall!.init.method).toBe('PUT');
    expect(playCall!.init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(playCall!.init.body)).toEqual({ uris: ['spotify:track:trk1'] });
    vi.unstubAllGlobals();
  });

  it('returns false when the Spotify Web API call itself fails', async () => {
    const fakePlayer = fakeSpotifyPlayer();
    fakePlayer.connect.mockImplementation(() => fakePlayer.fire('ready', { device_id: 'dev1' }));
    vi.stubGlobal('window', { Spotify: { Player: vi.fn(function () { return fakePlayer; }) } });
    stubPlayerTokenFetch({ available: true, accessToken: 'tok' }, (url) => {
      if (url.includes('api.spotify.com/v1/me/player/play')) return new Response(null, { status: 502 });
      return null;
    });

    await expect(playTrack('trk1')).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('pausePlayback / resumePlayback', () => {
  it('delegate to the connected SDK player, and no-op false when never connected', async () => {
    stubPlayerTokenFetch({ available: false });
    vi.stubGlobal('window', {});

    await expect(pausePlayback()).resolves.toBe(false);
    await expect(resumePlayback()).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it('call player.pause()/player.resume() once actually connected', async () => {
    const fakePlayer = fakeSpotifyPlayer();
    fakePlayer.connect.mockImplementation(() => fakePlayer.fire('ready', { device_id: 'dev1' }));
    vi.stubGlobal('window', { Spotify: { Player: vi.fn(function () { return fakePlayer; }) } });
    stubPlayerTokenFetch({ available: true, accessToken: 'tok' });

    await expect(pausePlayback()).resolves.toBe(true);
    expect(fakePlayer.pause).toHaveBeenCalledTimes(1);

    await expect(resumePlayback()).resolves.toBe(true);
    expect(fakePlayer.resume).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
