function parseDsn(dsn: string): { ingestHost: string; projectId: string; publicKey: string } | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace('/', '');
    return { ingestHost: url.host, projectId, publicKey: url.username };
  } catch {
    return null;
  }
}

export async function reportError(env: Env, error: unknown, context: { path: string }): Promise<void> {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return;

  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  const envelopeHeader = JSON.stringify({ event_id: crypto.randomUUID(), sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: 'event' });
  const item = JSON.stringify({
    message,
    level: 'error',
    extra: { stack, path: context.path },
    timestamp: Date.now() / 1000,
  });
  const body = `${envelopeHeader}\n${itemHeader}\n${item}`;

  try {
    await fetch(`https://${parsed.ingestHost}/api/${parsed.projectId}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}`,
      },
      body,
    });
  } catch {
    // Sentry being unreachable must never break the request path.
  }
}
