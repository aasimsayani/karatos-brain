import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { integrationStatuses } from "@karatos/core";
import { selectDepartments } from "@karatos/retail";
import { loadMigrations, migrate, PostgresMemoryStore } from "@karatos/store-postgres";
import { createBrainApp } from "./app.js";
import { createInstancePipeline } from "./brain.js";
import { loadInstanceConfig } from "./config.js";
import { StaticDocumentationSource } from "./documentation.js";
import { createRetentionRunner } from "./retention.js";
import { postgresDiagnostics } from "./support.js";
import { createSyncRunner, scheduledConnectors } from "./sync.js";

const startedAt = new Date();
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

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

// Each turned-on connector that has its settings syncs on a schedule. Skipped ones are named with what they're missing, never with values.
const { connectors, skipped } = scheduledConnectors(config.ENABLED_INTEGRATIONS, process.env, { memory, organizationId: config.ORGANIZATION_ID });
for (const { id, reason } of skipped) console.log(`sync ${id} skipped: ${reason}`);
const sync = createSyncRunner({
  connectors,
  pipeline,
  memory,
  organizationId: config.ORGANIZATION_ID,
  intervalMs: config.SYNC_INTERVAL_MINUTES * 60_000,
});

const server = createServer(
  createBrainApp({
    pipeline,
    memory,
    organizationId: config.ORGANIZATION_ID,
    apiKey: config.INSTANCE_API_KEY,
    // Support access: diagnostic routes only, never business data. See docs/security.md.
    ...(config.SUPPORT_API_KEY ? { supportApiKey: config.SUPPORT_API_KEY } : {}),
    integrations: integrationStatuses(process.env),
    support: {
      instanceName: config.INSTANCE_NAME,
      version,
      startedAt,
      retentionDays: config.RAW_RETENTION_DAYS,
      departments: selectDepartments(config.ENABLED_DEPARTMENTS).map((d) => d.id),
      enabledIntegrations: config.ENABLED_INTEGRATIONS,
      skipped,
      syncStatus: () => sync.latest(),
      diagnostics: postgresDiagnostics(pool),
    },
  }),
);
server.listen(config.PORT, () => {
  console.log(`${config.INSTANCE_NAME} (${config.ORGANIZATION_ID}) listening on :${config.PORT}${config.SUPPORT_API_KEY ? ", support access on" : ""}`);
});
sync.start();

// Slim copy: raw vendor data older than RAW_RETENTION_DAYS is cleared once a day. Facts, signals and source references stay.
const retention = createRetentionRunner({ store: memory, organizationId: config.ORGANIZATION_ID, retentionDays: config.RAW_RETENTION_DAYS });
retention.start();

const shutdown = () =>
  server.close(() => void Promise.all([sync.stop(), retention.stop()]).then(() => pool.end()).then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
