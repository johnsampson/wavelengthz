import { describe, it, expect, vi, afterEach } from 'vitest';
import { reverseGeocodeLabel } from '../../src/lib/geocode';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })));
}

describe('reverseGeocodeLabel', () => {
  it('joins city and region when both are present', async () => {
    stubFetch({ city: 'Austin', principalSubdivision: 'Texas', countryName: 'United States' });
    expect(await reverseGeocodeLabel(30.27, -97.74)).toBe('Austin, Texas');
  });

  it('falls back to city and country when there is no region', async () => {
    stubFetch({ city: 'Singapore', principalSubdivision: null, countryName: 'Singapore' });
    expect(await reverseGeocodeLabel(1.35, 103.82)).toBe('Singapore, Singapore');
  });

  it('uses locality as a fallback for a rural area with no city', async () => {
    stubFetch({ city: null, locality: 'Marfa', principalSubdivision: 'Texas', countryName: 'United States' });
    expect(await reverseGeocodeLabel(30.31, -104.02)).toBe('Marfa, Texas');
  });

  it('falls back to region and country when there is no city or locality at all', async () => {
    stubFetch({ city: null, locality: null, principalSubdivision: 'Yukon', countryName: 'Canada' });
    expect(await reverseGeocodeLabel(64.0, -139.0)).toBe('Yukon, Canada');
  });

  it('falls back to just the country when nothing else is available', async () => {
    stubFetch({ city: null, locality: null, principalSubdivision: null, countryName: 'Antarctica' });
    expect(await reverseGeocodeLabel(-75.25, -0.07)).toBe('Antarctica');
  });

  it('returns null when even the country is missing', async () => {
    stubFetch({});
    expect(await reverseGeocodeLabel(0, 0)).toBeNull();
  });

  it('returns null on a non-ok response rather than throwing', async () => {
    stubFetch({}, 500);
    expect(await reverseGeocodeLabel(30.27, -97.74)).toBeNull();
  });

  it('returns null when the fetch itself throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await reverseGeocodeLabel(30.27, -97.74)).toBeNull();
  });

  it('returns null on a malformed (non-JSON) response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await reverseGeocodeLabel(30.27, -97.74)).toBeNull();
  });

  it('requests BigDataCloud\'s reverse-geocode-client endpoint with the given coordinates', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ countryName: 'x' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await reverseGeocodeLabel(30.27, -97.74);

    const url = (fetchMock.mock.calls[0] as any)[0].toString();
    expect(url).toContain('https://api.bigdatacloud.net/data/reverse-geocode-client');
    expect(url).toContain('latitude=30.27');
    expect(url).toContain('longitude=-97.74');
  });
});
