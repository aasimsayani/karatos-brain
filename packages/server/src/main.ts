import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { integrationStatuses } from "@karatos/core";
import { loadMigrations, migrate, PostgresMemoryStore, PostgresWorkStore } from "@karatos/store-postgres";
import { createBrainApp } from "./app.js";
import { createInstancePipeline, instanceDepartments } from "./brain.js";
import { createBriefRunner, readDailyBrief, webhookDelivery } from "./brief.js";
import { instanceBenchSettings, instanceStoreHours, loadInstanceConfig } from "./config.js";
import { StaticDocumentationSource } from "./documentation.js";
import { createRetentionRunner } from "./retention.js";
import { createReasoningRunner, readLastRun, reasonNow } from "./reasoning.js";
import { postgresDiagnostics } from "./support.js";
import { createSyncRunner, scheduledConnectors } from "./sync.js";
import { createVerifier } from "./verify.js";

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

// When the store is open, on its own clock: clienteling's awaiting-reply rule counts only these hours.
const storeHours = instanceStoreHours(config);

const pool = new pg.Pool({ connectionString: config.SUPABASE_DB_URL, max: 10 });
const memory = new PostgresMemoryStore(pool);
const pipeline = createInstancePipeline({
  memory,
  documentation: new StaticDocumentationSource(config.DOC_REGISTRY_IDS),
  departments: config.ENABLED_DEPARTMENTS,
  storeHours,
  awaitingReplyHours: config.AWAITING_REPLY_HOURS,
  bench: instanceBenchSettings(config),
  // What the store did with earlier recommendations shapes the next run: dismissed subjects wait out this cooldown.
  feedbackCooldownDays: config.FEEDBACK_COOLDOWN_DAYS,
});

// Scheduled reasoning keeps findings fresh on its own: after each sync round that brings new events, before the
// daily brief, and at least every REASON_INTERVAL_MINUTES. Off with REASON_SCHEDULE=off, leaving it to POST /v1/reason.
// Either way the runner records every run, POST /v1/reason's included, and starts from the last run in the database.
const reasoning = createReasoningRunner({
  reason: async () => {
    const run = await reasonNow(pipeline, memory, config.ORGANIZATION_ID);
    return { recommendations: run.recommendations.length, measured: run.measured };
  },
  intervalMs: config.REASON_INTERVAL_MINUTES * 60_000,
  scheduled: config.REASON_SCHEDULE,
  lastRun: await readLastRun(memory, config.ORGANIZATION_ID),
});
const scheduledReasoning = config.REASON_SCHEDULE ? reasoning : null;

// Each turned-on connector that has its settings syncs on a schedule. Skipped ones are named with what they're missing, never with values.
const { connectors, skipped } = scheduledConnectors(config.ENABLED_INTEGRATIONS, process.env, { memory, organizationId: config.ORGANIZATION_ID });
for (const { id, reason } of skipped) console.log(`sync ${id} skipped: ${reason}`);
const sync = createSyncRunner({
  connectors,
  pipeline,
  memory,
  organizationId: config.ORGANIZATION_ID,
  intervalMs: config.SYNC_INTERVAL_MINUTES * 60_000,
  ...(scheduledReasoning ? { afterRound: (outcomes) => void scheduledReasoning.afterSync(outcomes) } : {}),
});

// What the daily brief knows about syncing: which connectors run, how each last went, which are turned on but not
// syncing, and when reasoning last refreshed the findings.
const briefSync = () => ({ scheduled: connectors.map((c) => c.id), statuses: sync.latest(), skipped, reasoning: reasoning.status() });

const server = createServer(
  createBrainApp({
    pipeline,
    memory,
    organizationId: config.ORGANIZATION_ID,
    apiKey: config.INSTANCE_API_KEY,
    // Support access: diagnostic routes only, never business data. See docs/security.md.
    ...(config.SUPPORT_API_KEY ? { supportApiKey: config.SUPPORT_API_KEY } : {}),
    integrations: integrationStatuses(process.env),
    brief: { timeZone: config.STORE_TIME_ZONE, sync: briefSync },
    // POST /v1/verify: the source systems' own totals beside what has synced, read-only. See docs/verify-sync.md.
    verify: createVerifier({ memory, organizationId: config.ORGANIZATION_ID, connectors, skipped }),
    // POST /v1/reason runs in line with scheduled runs, never beside one, and is recorded like them.
    reason: (pass) => reasoning.manual(pass),
    // Reasoning sessions and agent tasks, kept in Postgres so work resumes after a restart. Read-only task kinds only.
    work: { store: new PostgresWorkStore(pool) },
    support: {
      instanceName: config.INSTANCE_NAME,
      version,
      startedAt,
      retentionDays: config.RAW_RETENTION_DAYS,
      settings: { storeHours, awaitingReplyHours: config.AWAITING_REPLY_HOURS },
      departments: instanceDepartments(config.ENABLED_DEPARTMENTS).map((d) => d.id),
      enabledIntegrations: config.ENABLED_INTEGRATIONS,
      skipped,
      syncStatus: () => sync.latest(),
      reasoning: () => reasoning.supportStatus(),
      diagnostics: postgresDiagnostics(pool),
    },
  }),
);
server.listen(config.PORT, () => {
  console.log(`${config.INSTANCE_NAME} (${config.ORGANIZATION_ID}) listening on :${config.PORT}${config.SUPPORT_API_KEY ? ", support access on" : ""}`);
});
sync.start();
reasoning.start();

// Slim copy: raw vendor data older than RAW_RETENTION_DAYS is cleared once a day. Facts, signals and source references stay.
const retention = createRetentionRunner({ store: memory, organizationId: config.ORGANIZATION_ID, retentionDays: config.RAW_RETENTION_DAYS });
retention.start();

// Yesterday's brief, built and saved once each morning at BRIEF_HOUR on the store's clock. Sent on only to BRIEF_WEBHOOK_URL, when an operator set one.
const brief = createBriefRunner({
  store: memory,
  organizationId: config.ORGANIZATION_ID,
  timeZone: config.STORE_TIME_ZONE,
  hour: config.BRIEF_HOUR,
  build: (date) => readDailyBrief({ memory, organizationId: config.ORGANIZATION_ID, timeZone: config.STORE_TIME_ZONE, sync: briefSync }, date),
  // Findings are refreshed first, unless a run has just done it, so the morning brief never reports stale reasoning.
  ...(scheduledReasoning ? { beforeBuild: () => scheduledReasoning.beforeBrief() } : {}),
  ...(config.BRIEF_WEBHOOK_URL ? { deliver: webhookDelivery(config.BRIEF_WEBHOOK_URL) } : {}),
});
brief.start();

const shutdown = () =>
  server.close(() => void Promise.all([sync.stop(), reasoning.stop(), retention.stop(), brief.stop()]).then(() => pool.end()).then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
