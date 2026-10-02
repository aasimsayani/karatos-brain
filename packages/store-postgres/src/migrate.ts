import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlClient } from "./client.js";

export interface Migration {
  name: string;
  sql: string;
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(join(directory, name), "utf8") })));
}

/**
 * Applies migrations in filename order, each exactly once, recording them in
 * schema_migrations. Returns the names applied on this run.
 */
export async function migrate(client: SqlClient, migrations: Migration[]): Promise<string[]> {
  await client.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query("insert into schema_migrations (name) values ($1)", [migration.name]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`);
    }
    ran.push(migration.name);
  }
  return ran;
}
