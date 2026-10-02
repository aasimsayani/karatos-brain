import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "node:url";
import { loadMigrations, migrate, type SqlClient } from "../src/index.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

/** Adapts PGlite to SqlClient: parameterless calls may hold several statements, like pg. */
export function pgliteClient(db: PGlite): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      if (params === undefined || params.length === 0) {
        const results = await db.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      const result = await db.query<T>(text, params);
      return { rows: result.rows };
    },
  };
}

export async function freshDatabase(): Promise<{ db: PGlite; client: SqlClient }> {
  const db = new PGlite();
  const client = pgliteClient(db);
  await migrate(client, await loadMigrations(MIGRATIONS_DIR));
  return { db, client };
}
