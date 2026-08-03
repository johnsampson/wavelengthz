import { getClientCredentialsToken, searchArtistsByGenre, fetchArtistTopTracks } from '../lib/spotify';

export const SEED_GENRES = [
  'pop', 'hip-hop', 'indie', 'r-n-b', 'country', 'electronic',
  'latin', 'rock', 'k-pop', 'jazz', 'classical', 'reggaeton',
];

const ARTISTS_PER_GENRE = 5;
const TRACKS_PER_ARTIST = 2;

export async function seedCatalog(
  env: Env
): Promise<{ artistsInserted: number; tracksInserted: number; failedArtistIds: string[] }> {
  const token = await getClientCredentialsToken(env);
  const seen = new Set<string>();
  let artistsInserted = 0;
  let tracksInserted = 0;
  const failedArtistIds: string[] = [];
  const now = Date.now();

  for (const genre of SEED_GENRES) {
    let artists: Array<{ id: string; name: string; genres: string[]; images: Array<{ url: string }>; popularity: number }>;
    try {
      artists = await searchArtistsByGenre(token, genre, ARTISTS_PER_GENRE);
    } catch {
      // One genre's search failing (transient 429/500) shouldn't abort the
      // whole ~50-artist run — skip this genre and keep going with the rest.
      continue;
    }

    for (const artist of artists) {
      if (seen.has(artist.id)) continue;
      seen.add(artist.id);

      try {
        // Wrap the full per-artist unit of work (artist insert + top-tracks
        // fetch + track inserts) so a failure anywhere in it — most likely a
        // transient error from the top-tracks fetch, but also possible on
        // the insert itself — only drops this one artist, not the run.
        const artistResult = await env.DB.prepare(
          `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
           VALUES (?, ?, ?, ?, ?, 'seed', NULL, 1, ?)`
        )
          .bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, now)
          .run();
        if (artistResult.meta.changes > 0) artistsInserted += 1;

        const tracks = await fetchArtistTopTracks(token, artist.id);
        for (const track of tracks.slice(0, TRACKS_PER_ARTIST)) {
          const trackResult = await env.DB.prepare(
            `INSERT OR IGNORE INTO tracks (id, name, artist_id, album_image_url, preview_url, source, added_by_user_id, approved, created_at)
             VALUES (?, ?, ?, ?, ?, 'seed', NULL, 1, ?)`
          )
            .bind(track.id, track.name, artist.id, track.album?.images?.[0]?.url ?? null, track.preview_url ?? null, now)
            .run();
          if (trackResult.meta.changes > 0) tracksInserted += 1;
        }
      } catch {
        failedArtistIds.push(artist.id);
      }
    }
  }

  return { artistsInserted, tracksInserted, failedArtistIds };
}
