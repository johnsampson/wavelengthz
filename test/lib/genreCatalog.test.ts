import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { recordCatalogGenres } from '../../src/lib/genreCatalog';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM genres;');
});

async function rowFor(genre: string) {
  return env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind(genre).first<any>();
}

describe('recordCatalogGenres', () => {
  it('creates a new row with artist_count 1 when recording an artist genre', async () => {
    await recordCatalogGenres(env.DB, ['indie'], 'artist', 1000);
    const row = await rowFor('indie');
    expect(row.artist_count).toBe(1);
    expect(row.track_count).toBe(0);
  });

  it('creates a new row with track_count 1 when recording a track genre', async () => {
    await recordCatalogGenres(env.DB, ['jazz'], 'track', 1000);
    const row = await rowFor('jazz');
    expect(row.artist_count).toBe(0);
    expect(row.track_count).toBe(1);
  });

  it('accumulates across multiple calls for the same genre', async () => {
    await recordCatalogGenres(env.DB, ['pop'], 'artist', 1000);
    await recordCatalogGenres(env.DB, ['pop'], 'artist', 2000);
    await recordCatalogGenres(env.DB, ['pop'], 'track', 3000);

    const row = await rowFor('pop');
    expect(row.artist_count).toBe(2);
    expect(row.track_count).toBe(1);
    expect(row.updated_at).toBe(3000);
  });

  it('records every genre in the array independently', async () => {
    await recordCatalogGenres(env.DB, ['rock', 'metal'], 'artist', 1000);
    expect((await rowFor('rock')).artist_count).toBe(1);
    expect((await rowFor('metal')).artist_count).toBe(1);
  });

  it('does nothing for an empty genre list', async () => {
    await recordCatalogGenres(env.DB, [], 'artist', 1000);
    const rows = await env.DB.prepare('SELECT COUNT(*) as c FROM genres').first<any>();
    expect(rows.c).toBe(0);
  });
});
