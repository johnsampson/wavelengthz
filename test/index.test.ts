import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applySchema } from './apply-schema';
import worker from '../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('worker root', () => {
  it('returns 404 for an unknown route', async () => {
    const req = new Request('http://localhost/does-not-exist');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });

  it('DB binding has the users table after schema apply', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).first();
    expect(result?.name).toBe('users');
  });
});
