import { getClientCredentialsToken, fetchArtistById } from '../lib/spotify';

export async function refreshCatalogFromProfiles(env: Env): Promise<{ artistsAdded: number }> {
  const profiles = await env.DB.prepare('SELECT top_artists FROM music_profiles').all<{ top_artists: string }>();

  const candidateIds = new Set<string>();
  for (const row of profiles.results) {
    const artists: Array<{ artist_id: string }> = JSON.parse(row.top_artists);
    for (const artist of artists) candidateIds.add(artist.artist_id);
  }

  let token: string | null = null;
  let artistsAdded = 0;

  for (const artistId of candidateIds) {
    const existing = await env.DB.prepare('SELECT 1 FROM artists WHERE id = ?').bind(artistId).first();
    if (existing) continue;

    if (!token) token = await getClientCredentialsToken(env);
    const artist = await fetchArtistById(token, artistId);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 'spotify_search', NULL, 1, ?)`
    ).bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, Date.now()).run();
    artistsAdded += 1;
  }

  return { artistsAdded };
}
