import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from './createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
});

describe('insertTestUser', () => {
  it('inserts a users row plus matching auth_identities and music_source_tokens rows', async () => {
    const id = await insertTestUser(env.DB, { email: 'a@example.com' });

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>();
    expect(user.email).toBe('a@example.com');

    const identity = await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind(id).first<any>();
    expect(identity.provider).toBe('spotify');
    expect(identity.provider_id).toBeTruthy();

    const token = await env.DB.prepare('SELECT * FROM music_source_tokens WHERE user_id = ?').bind(id).first<any>();
    expect(token.provider).toBe('spotify');
    expect(token.access_token).toBeTruthy();
    expect(token.token_expires_at).toBeGreaterThan(Date.now());
  });

  it('respects overrides for id, spotifyId, and profile fields', async () => {
    const id = await insertTestUser(env.DB, { id: 'fixed-id', spotifyId: 'fixed-spotify-id', lat: 30.27, lng: -97.74, gender: 'female', seeking: 'female' });

    expect(id).toBe('fixed-id');
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>();
    expect(user.lat).toBe(30.27);
    expect(user.gender).toBe('female');
    const identity = await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind(id).first<any>();
    expect(identity.provider_id).toBe('fixed-spotify-id');
  });
});

describe('insertTestUser with skipSpotify', () => {
  it('creates only the users row, with no auth_identities or music_source_tokens rows', async () => {
    const id = await insertTestUser(env.DB, { skipSpotify: true });

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>();
    expect(user).toBeTruthy();

    const identity = await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind(id).first();
    expect(identity).toBeNull();

    const token = await env.DB.prepare('SELECT * FROM music_source_tokens WHERE user_id = ?').bind(id).first();
    expect(token).toBeNull();
  });
});
