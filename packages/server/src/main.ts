import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { BrainPipeline } from "@karatos/core";
import { loadMigrations, migrate, PostgresMemoryStore } from "@karatos/store-postgres";
import { createBrainApp } from "./app.js";
import { loadInstanceConfig } from "./config.js";
import { StaticDocumentationSource } from "./documentation.js";

const config = loadInstanceConfig(process.env);
const migrationsDir = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

// Migrations run on one dedicated connection so begin/commit stay together.
const setup = new pg.Client({ connectionString: config.SUPABASE_DB_URL });
await setup.connect();
try {
  if (config.MIGRATE_ON_START) {
    const ran = await migrate(setup, await loadMigrations(migrationsDir));
    if (ran.length) console.log(`applied migrations: ${ran.join(", ")}`);
  }
  await setup.query(
    "insert into organizations (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name",
    [config.ORGANIZATION_ID, config.INSTANCE_NAME],
  );
} finally {
  await setup.end();
}

const pool = new pg.Pool({ connectionString: config.SUPABASE_DB_URL, max: 10 });
const pipeline = new BrainPipeline({
  memory: new PostgresMemoryStore(pool),
  normalizers: [],
  extractors: [],
  reasoners: [],
  documentation: new StaticDocumentationSource(config.DOC_REGISTRY_IDS),
});

const server = createServer(
  createBrainApp({ pipeline, organizationId: config.ORGANIZATION_ID, apiKey: config.INSTANCE_API_KEY }),
);
server.listen(config.PORT, () => {
  console.log(`${config.INSTANCE_NAME} (${config.ORGANIZATION_ID}) listening on :${config.PORT}`);
});

const shutdown = () => server.close(() => void pool.end().then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
