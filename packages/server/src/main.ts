import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { integrationStatuses } from "@karatos/core";
import { loadMigrations, migrate, PostgresMemoryStore } from "@karatos/store-postgres";
import { createBrainApp } from "./app.js";
import { createInstancePipeline } from "./brain.js";
import { loadInstanceConfig } from "./config.js";
import { StaticDocumentationSource } from "./documentation.js";
import { createSyncRunner, scheduledConnectors } from "./sync.js";

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
const memory = new PostgresMemoryStore(pool);
const pipeline = createInstancePipeline({
  memory,
  documentation: new StaticDocumentationSource(config.DOC_REGISTRY_IDS),
  departments: config.ENABLED_DEPARTMENTS,
});

const server = createServer(
  createBrainApp({
    pipeline,
    memory,
    organizationId: config.ORGANIZATION_ID,
    apiKey: config.INSTANCE_API_KEY,
    integrations: integrationStatuses(process.env),
  }),
);
server.listen(config.PORT, () => {
  console.log(`${config.INSTANCE_NAME} (${config.ORGANIZATION_ID}) listening on :${config.PORT}`);
});

// Each turned-on connector that has its settings syncs on a schedule. Skipped ones are named with what they're missing, never with values.
const { connectors, skipped } = scheduledConnectors(config.ENABLED_INTEGRATIONS, process.env);
for (const { id, reason } of skipped) console.log(`sync ${id} skipped: ${reason}`);
const sync = createSyncRunner({
  connectors,
  pipeline,
  memory,
  organizationId: config.ORGANIZATION_ID,
  intervalMs: config.SYNC_INTERVAL_MINUTES * 60_000,
});
sync.start();

const shutdown = () => server.close(() => void sync.stop().then(() => pool.end()).then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
