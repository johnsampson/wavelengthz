// Migrations are the single source of truth for the schema (see
// migrations/README.md) -- applying them in filename order here is what
// keeps the test database's schema identical to what `wrangler d1
// migrations apply` produces locally and in production.
// @ts-ignore - Vite raw text import, no type declaration needed
const migrationModules = import.meta.glob('../migrations/*.sql', { query: '?raw', import: 'default', eager: true });

function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function applySchema(db: D1Database): Promise<void> {
  const orderedPaths = Object.keys(migrationModules).sort();
  for (const path of orderedPaths) {
    const sql = migrationModules[path] as string;
    for (const statement of splitStatements(sql)) {
      await db.prepare(statement).run();
    }
  }
}
