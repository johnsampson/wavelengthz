import { schema } from '../src/db/schema';

export async function applySchema(db: D1Database): Promise<void> {
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}
