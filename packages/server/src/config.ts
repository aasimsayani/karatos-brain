import { z } from "zod";
import { DEFAULT_FEEDBACK_POLICY, DEFAULT_RAW_RETENTION_DAYS, INTEGRATIONS, MAX_FEEDBACK_COOLDOWN_DAYS, invalidWriteEntries, MAX_RAW_RETENTION_DAYS, MIN_RAW_RETENTION_DAYS } from "@karatos/core";
import { BENCH_METAL_LOSS_SHARE, parseDailyHours, parseLaborRates, parseStageLimits, type BenchSettings, type ProductionSettings } from "@karatos/manufacturing";
import { DEFAULT_BRIEF_TIME_ZONE, DEFAULT_STORE_HOURS, isTimeZone, parseClosedDates, parseStoreHours, REPLY_BUSINESS_HOURS, type StoreHours } from "@karatos/retail";
import { INSTANCE_DEPARTMENTS } from "./brain.js";

const DEPARTMENT_IDS = INSTANCE_DEPARTMENTS.map((d) => d.id);
const INTEGRATION_IDS = INTEGRATIONS.map((i) => i.id);

const commaList = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** A setting read by `parse`, whose error message, naming the bad part, becomes the setting's. */
function readWith<T>(parse: (value: string) => T) {
  return (value: string, ctx: z.RefinementCtx): T => {
    try {
      return parse(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  };
}

/**
 * Settings for one deployed instance. An instance belongs to exactly one
 * client: it has its own organization id, API key and database, and never
 * serves another client's data.
 */
const API_KEY = z.string().min(32, "use at least 32 random characters, e.g. from: openssl rand -hex 32");

export const InstanceConfigSchema = z
  .object({
  INSTANCE_NAME: z.string().min(1),
  ORGANIZATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "use lowercase letters, digits and dashes, e.g. fuse-jewelry"),
  /** Shared secret callers send as "Authorization: Bearer <key>". */
  INSTANCE_API_KEY: API_KEY,
  /**
   * Optional key for support access: it reaches only GET /healthz,
   * GET /v1/integrations and GET /v1/support/status, never business data.
   */
  SUPPORT_API_KEY: API_KEY.optional(),
  SUPABASE_DB_URL: z.string().startsWith("postgres"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Apply pending database migrations when the instance starts. */
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Comma-separated ids of the source-of-truth docs reasoning must consult. */
  DOC_REGISTRY_IDS: commaList,
  /** Comma-separated departments to run, e.g. sales,inventory,repairs,bench. Empty runs all of them. */
  ENABLED_DEPARTMENTS: commaList.refine((ids) => ids.every((id) => DEPARTMENT_IDS.includes(id)), {
    message: `use any of: ${DEPARTMENT_IDS.join(", ")}`,
  }),
  /**
   * Comma-separated writes to outside systems this instance allows, e.g.
   * shopify:adjust_inventory or shopify:*. Empty keeps every integration read-only.
   */
  ENABLED_WRITES: commaList.refine((entries) => invalidWriteEntries(entries).length === 0, {
    message: "use integration:action or integration:*, e.g. shopify:adjust_inventory",
  }),
  /** Comma-separated catalog ids of the integrations this instance uses, e.g. shopify,stripe. Built connectors among them are synced. */
  ENABLED_INTEGRATIONS: commaList.refine((ids) => ids.every((id) => INTEGRATION_IDS.includes(id)), {
    message: "use catalog integration ids, e.g. shopify,stripe,inventory_pos,bank_statements",
  }),
  /** Minutes between the end of one sync round and the start of the next. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /**
   * Scheduled reasoning: the department rules run after each sync round that
   * brings new events, before the daily brief and at least every
   * REASON_INTERVAL_MINUTES. "off" leaves it to POST /v1/reason.
   */
  REASON_SCHEDULE: z
    .enum(["on", "off"])
    .default("on")
    .transform((v) => v === "on"),
  /** The longest gap, in minutes, between the end of one scheduled reasoning run and the start of the next. */
  REASON_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /**
   * Days a recommendation that was dismissed is held back before the same
   * rule raises the same subject again, unless its dollar estimate or
   * confidence grew. 0 turns the cooldown off. See docs/feedback-loop.md.
   */
  FEEDBACK_COOLDOWN_DAYS: z.coerce.number().int().min(0).max(MAX_FEEDBACK_COOLDOWN_DAYS).default(DEFAULT_FEEDBACK_POLICY.cooldownDays),
  /**
   * Days raw vendor data (event payloads, dead-letter input, uploaded file
   * contents) is kept before it is cleared. Facts, signals and source
   * references are kept. See docs/architecture/data-retention.md.
   */
  RAW_RETENTION_DAYS: z.coerce.number().int().min(MIN_RAW_RETENTION_DAYS).max(MAX_RAW_RETENTION_DAYS).default(DEFAULT_RAW_RETENTION_DAYS),
  /** The store's IANA time zone: the daily brief's days run midnight to midnight there. */
  STORE_TIME_ZONE: z.string().default(DEFAULT_BRIEF_TIME_ZONE).refine(isTimeZone, { message: "use an IANA time zone, e.g. America/New_York" }),
  /** The hour on the store's clock from which yesterday's daily brief is built. See docs/daily-brief.md. */
  BRIEF_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  /**
   * When the store is open, on STORE_TIME_ZONE's clock, e.g.
   * "mon-fri 10:00-18:00; sat 10:00-17:00; sun closed". Clienteling's
   * awaiting-reply rule counts only these hours. See docs/deployment/instances.md#store-hours.
   */
  STORE_HOURS: z.string().default(DEFAULT_STORE_HOURS).transform(readWith(parseStoreHours)),
  /** Comma-separated YYYY-MM-DD days the store is shut whatever STORE_HOURS says, such as holidays. */
  STORE_CLOSED_DATES: z.string().default("").transform(readWith(parseClosedDates)),
  /** Open hours a customer's message waits for an answer before clienteling's awaiting-reply rule raises it. */
  AWAITING_REPLY_HOURS: z.coerce.number().int().min(1).max(72).default(REPLY_BUSINESS_HOURS),
  /**
   * Whole days a bench job can sit in a stage before it is raised as stuck: one number for every stage,
   * stages of their own ("casting=5, setting=3"), or both. See docs/departments/bench.md.
   */
  BENCH_STAGE_LIMIT_DAYS: z.string().default("").transform(readWith(parseStageLimits)),
  /** The metal a bench job may lose across its stages, as a percent of the most issued to it, above 0 and up to 50. */
  BENCH_METAL_LOSS_PERCENT: z.coerce.number().gt(0).max(50).default(BENCH_METAL_LOSS_SHARE * 100),
  /**
   * What an hour of bench time costs, in dollars from 1 to 1000: one figure for everyone, jewelers' own
   * ("Ana=55"), or both ("45, Ana=55"). Empty is $45. See docs/departments/production.md.
   */
  BENCH_LABOR_RATE: z.string().default("").transform(readWith(parseLaborRates)),
  /** Hours of bench work a jeweler does in a working day, 0.5 to 24, written the same way. Empty is 6. */
  BENCH_DAILY_HOURS: z.string().default("").transform(readWith(parseDailyHours)),
  /** Optional https address the daily brief is posted to. Off when unset. A secret: such addresses carry tokens. */
  BRIEF_WEBHOOK_URL: z.url({ protocol: /^https$/ }).optional(),
  })
  // The same value would hand the support holder every route.
  .refine((c) => c.SUPPORT_API_KEY === undefined || c.SUPPORT_API_KEY !== c.INSTANCE_API_KEY, {
    path: ["SUPPORT_API_KEY"],
    message: "must differ from INSTANCE_API_KEY",
  });

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;

/** The store's hours from STORE_TIME_ZONE, STORE_HOURS and STORE_CLOSED_DATES. */
export function instanceStoreHours(config: Pick<InstanceConfig, "STORE_TIME_ZONE" | "STORE_HOURS" | "STORE_CLOSED_DATES">): StoreHours {
  return { timeZone: config.STORE_TIME_ZONE, week: config.STORE_HOURS, closedDates: config.STORE_CLOSED_DATES };
}

/** The bench rules' settings from BENCH_STAGE_LIMIT_DAYS and BENCH_METAL_LOSS_PERCENT. */
export function instanceBenchSettings(config: Pick<InstanceConfig, "BENCH_STAGE_LIMIT_DAYS" | "BENCH_METAL_LOSS_PERCENT">): BenchSettings {
  return { stageLimitDays: config.BENCH_STAGE_LIMIT_DAYS, metalLossShare: config.BENCH_METAL_LOSS_PERCENT / 100 };
}

/** Production planning's settings from BENCH_LABOR_RATE and BENCH_DAILY_HOURS. */
export function instanceProductionSettings(config: Pick<InstanceConfig, "BENCH_LABOR_RATE" | "BENCH_DAILY_HOURS">): Omit<ProductionSettings, "storeHours"> {
  return { laborRateCents: config.BENCH_LABOR_RATE, dailyHours: config.BENCH_DAILY_HOURS };
}

export function loadInstanceConfig(env: Record<string, string | undefined>): InstanceConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = InstanceConfigSchema.safeParse(cleaned);
  if (!result.success) {
    // Name the bad settings without echoing their values.
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid instance configuration: ${problems}`);
  }
  return result.data;
}
