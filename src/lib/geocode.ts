// Reverse geocoding: turns a lat/lng pair into a human-readable "City,
// Region" (or "Region, Country" / "Country" when a city isn't available)
// label. Issue #145 (Round 7) item 3: "is it easy to translate lat lon on
// file to a city or state/region or country?" -- replaces the literal
// "Current location" placeholder public/onboarding.html's and
// public/settings/preferences.js's useBrowserLocation() both send when
// someone shares their browser location, rather than asking them to type
// their own city.
//
// Uses BigDataCloud's free reverse-geocode-client endpoint
// (api.bigdatacloud.net) -- no API key, documented for exactly this
// client-or-server lookup, and generous enough for this app's volume (one
// call per onboarding/location-change submission, not per request).
//
// Fails soft, always: a third-party geocoding outage or an unexpected
// response shape must never block onboarding or a settings save. Any
// failure here returns null, and the caller keeps whatever label the
// client already sent (the "Current location" placeholder itself, worst
// case -- no worse than today).
export async function reverseGeocodeLabel(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json<{
      city?: string | null;
      locality?: string | null;
      principalSubdivision?: string | null;
      countryName?: string | null;
    }>();

    // `city` is usually populated in an urban area; `locality` is
    // BigDataCloud's own fallback for anywhere it isn't (a small town,
    // rural area). Neither is guaranteed, so this degrades gracefully all
    // the way down to just a country name rather than returning null for
    // anything less than a perfect match.
    const city = data.city || data.locality || null;
    const region = data.principalSubdivision || null;
    const country = data.countryName || null;

    if (city) return region ? `${city}, ${region}` : country ? `${city}, ${country}` : city;
    if (region) return country ? `${region}, ${country}` : region;
    return country;
  } catch {
    return null;
  }
}
