import { readFile } from "node:fs/promises";
import pg from "pg";
import { loadMigrations, migrate } from "../packages/store-postgres/src/index.js";
import { loadEnv } from "./env.js";

// Applies supabase/migrations to SUPABASE_DB_URL. Pass --seed to load sample data.
const env = loadEnv();
if (!env.SUPABASE_DB_URL) {
  console.log("SUPABASE_DB_URL is not set. Copy the connection string from Supabase > Project Settings > Database.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
await client.connect();
try {
  const ran = await migrate(client, await loadMigrations("supabase/migrations"));
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database already up to date.");
  if (process.argv.includes("--seed")) {
    await client.query(await readFile("supabase/seed.sql", "utf8"));
    console.log("Seed data loaded.");
  }
} finally {
  await client.end();
}
