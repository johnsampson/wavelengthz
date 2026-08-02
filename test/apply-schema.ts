// @ts-ignore - Vite raw text import, no type declaration needed
import schemaSql from '../src/db/schema.sql?raw';

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
  for (const statement of splitStatements(schemaSql)) {
    await db.prepare(statement).run();
  }
}
