import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from '../helpers/createUser';
import { recordEvent, distinctActiveUserCount } from '../../src/lib/analytics';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM analytics_events; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
});

describe('recordEvent', () => {
  it('inserts an event row with the given user, type, and metadata', async () => {
    await insertTestUser(env.DB, { id: 'u1' });

    await recordEvent(env.DB, { userId: 'u1', eventType: 'song_play', metadata: JSON.stringify({ trackId: 't1' }) }, 1000);

    const row = await env.DB.prepare('SELECT * FROM analytics_events').first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.event_type).toBe('song_play');
    expect(row.metadata).toBe(JSON.stringify({ trackId: 't1' }));
    expect(row.created_at).toBe(1000);
    expect(row.updated_at).toBe(1000);
  });

  it('accepts a null userId for an anonymous event', async () => {
    await recordEvent(env.DB, { userId: null, eventType: 'session_start' }, 1000);

    const row = await env.DB.prepare('SELECT * FROM analytics_events').first<any>();
    expect(row.user_id).toBeNull();
    expect(row.metadata).toBeNull();
  });
});

describe('distinctActiveUserCount', () => {
  it('counts each identified user once, regardless of how many events they logged', async () => {
    await insertTestUser(env.DB, { id: 'u1' });
    await recordEvent(env.DB, { userId: 'u1', eventType: 'session_start' }, 2000);
    await recordEvent(env.DB, { userId: 'u1', eventType: 'song_play' }, 2500);

    const result = await distinctActiveUserCount(env.DB, 1000);

    expect(result.distinctUsers).toBe(1);
  });

  it('excludes events older than the given cutoff', async () => {
    await insertTestUser(env.DB, { id: 'u1' });
    await recordEvent(env.DB, { userId: 'u1', eventType: 'session_start' }, 500);

    const result = await distinctActiveUserCount(env.DB, 1000);

    expect(result.distinctUsers).toBe(0);
  });

  it('counts anonymous events separately from distinctUsers, not folded into it', async () => {
    await recordEvent(env.DB, { userId: null, eventType: 'session_start' }, 2000);
    await recordEvent(env.DB, { userId: null, eventType: 'session_start' }, 2500);

    const result = await distinctActiveUserCount(env.DB, 1000);

    expect(result.distinctUsers).toBe(0);
    expect(result.anonymousEvents).toBe(2);
  });
});
