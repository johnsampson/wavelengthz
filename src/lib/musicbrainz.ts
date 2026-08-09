// MusicBrainz requires a descriptive User-Agent identifying the calling
// application (their stated API etiquette) -- a generic/browser-like
// User-Agent risks getting silently deprioritized or blocked.
const MUSICBRAINZ_USER_AGENT = 'Wavelengthz/1.0 (https://wavelengthz.com)';

interface MusicBrainzUrlSearchResponse {
  urls?: Array<{
    resource: string;
    'relation-list'?: Array<{
      relations?: Array<{ artist?: { id: string } }>;
    }>;
  }>;
}

// Bridges a Spotify artist id to a MusicBrainz artist id (MBID) via an exact
// match, not a fuzzy name search: MusicBrainz editors attach a "streaming"
// relationship linking an artist directly to their open.spotify.com page, so
// searching for that exact URL returns the linked artist with no name
// ambiguity at all when a link exists. Coverage isn't universal -- only
// artists someone has bothered to link -- so a miss here just means no MBID
// yet, not a wrong one.
export async function lookupMusicBrainzArtistId(spotifyArtistId: string): Promise<string | null> {
  const query = `url:https://open.spotify.com/artist/${spotifyArtistId}`;
  const res = await fetch(`https://musicbrainz.org/ws/2/url/?query=${encodeURIComponent(query)}&fmt=json`, {
    headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT },
  });
  if (!res.ok) throw new Error(`MusicBrainz url search failed: ${res.status} ${await res.text()}`);

  const data = await res.json<MusicBrainzUrlSearchResponse>();
  for (const urlEntity of data.urls ?? []) {
    for (const relation of urlEntity['relation-list'] ?? []) {
      for (const rel of relation.relations ?? []) {
        if (rel.artist?.id) return rel.artist.id;
      }
    }
  }
  return null;
}

export interface MusicBrainzGenre {
  id: string;
  name: string;
  count: number;
}

// The url-search response above never carries genre data itself (confirmed
// directly against the live API -- its own `inc=genres` param is a no-op on
// that endpoint), so this is always a second, separate call once an MBID is
// known.
export async function fetchMusicBrainzGenres(mbid: string): Promise<MusicBrainzGenre[]> {
  const res = await fetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=genres&fmt=json`, {
    headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT },
  });
  if (!res.ok) throw new Error(`MusicBrainz artist lookup failed: ${res.status} ${await res.text()}`);

  const data = await res.json<{ genres?: Array<{ id: string; name: string; count: number }> }>();
  return (data.genres ?? []).map((g) => ({ id: g.id, name: g.name, count: g.count }));
}
