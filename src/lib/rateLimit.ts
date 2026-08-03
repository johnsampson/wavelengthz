export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const storageKey = `ratelimit:${key}:${bucket}`;

  const current = Number((await kv.get(storageKey)) ?? '0');
  if (current >= limit) return false;

  await kv.put(storageKey, String(current + 1), { expirationTtl: windowSeconds });
  return true;
}
