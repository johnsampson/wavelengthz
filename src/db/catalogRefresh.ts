import { getClientCredentialsToken, fetchArtistById } from '../lib/spotify';
import { recordCatalogGenres } from '../lib/genreCatalog';
import { upsertArtist } from '../lib/catalogUpsert';

export async function refreshCatalogFromProfiles(
  env: Env
): Promise<{ artistsAdded: number; failedArtistIds: string[] }> {
  const profiles = await env.DB.prepare('SELECT top_artists FROM music_profiles').all<{ top_artists: string }>();

  const candidateIds = new Set<string>();
  for (const row of profiles.results) {
    const artists: Array<{ artist_id: string }> = JSON.parse(row.top_artists);
    for (const artist of artists) candidateIds.add(artist.artist_id);
  }

  let token: string | null = null;
  let artistsAdded = 0;
  const failedArtistIds: string[] = [];

  for (const artistId of candidateIds) {
    const existing = await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind(artistId).first();
    if (existing) continue;

    try {
      // Wrap the per-artist fetch + insert so a transient failure (e.g. a
      // 429/500 from Spotify, or a stale artist id) only drops this one
      // artist instead of aborting the rest of an unattended weekly run.
      if (!token) token = await getClientCredentialsToken(env);
      const artist = await fetchArtistById(token, artistId);

      const now = Date.now();
      const result = await upsertArtist(env.DB, artist, 'spotify_search', null, now);
      artistsAdded += 1;
      await recordCatalogGenres(env.DB, artist.genres ?? [], 'artist', now);
      if (result.inserted) await env.GENRE_ENRICHMENT_QUEUE.send({ artistId: result.id });
    } catch {
      failedArtistIds.push(artistId);
    }
  }

  return { artistsAdded, failedArtistIds };
}
