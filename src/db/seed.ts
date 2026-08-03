import { getClientCredentialsToken, searchArtistsByGenre, fetchArtistTopTracks } from '../lib/spotify';

export const SEED_GENRES = [
  'pop', 'hip-hop', 'indie', 'r-n-b', 'country', 'electronic',
  'latin', 'rock', 'k-pop', 'jazz', 'classical', 'reggaeton',
];

const ARTISTS_PER_GENRE = 5;
const TRACKS_PER_ARTIST = 2;

export async function seedCatalog(env: Env): Promise<{ artistsInserted: number; tracksInserted: number }> {
  const token = await getClientCredentialsToken(env);
  const seen = new Set<string>();
  let artistsInserted = 0;
  let tracksInserted = 0;
  const now = Date.now();

  for (const genre of SEED_GENRES) {
    const artists = await searchArtistsByGenre(token, genre, ARTISTS_PER_GENRE);
    for (const artist of artists) {
      if (seen.has(artist.id)) continue;
      seen.add(artist.id);

      await env.DB.prepare(
        `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
         VALUES (?, ?, ?, ?, ?, 'seed', NULL, 1, ?)`
      ).bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, now).run();
      artistsInserted += 1;

      const tracks = await fetchArtistTopTracks(token, artist.id);
      for (const track of tracks.slice(0, TRACKS_PER_ARTIST)) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO tracks (id, name, artist_id, album_image_url, preview_url, source, added_by_user_id, approved, created_at)
           VALUES (?, ?, ?, ?, ?, 'seed', NULL, 1, ?)`
        ).bind(track.id, track.name, artist.id, track.album?.images?.[0]?.url ?? null, track.preview_url ?? null, now).run();
        tracksInserted += 1;
      }
    }
  }

  return { artistsInserted, tracksInserted };
}
