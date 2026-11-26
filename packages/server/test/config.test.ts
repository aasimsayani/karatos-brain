import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STORE_HOURS } from "@karatos/retail";
import { instanceBenchSettings, instanceStoreHours, loadInstanceConfig } from "../src/index.js";

const valid = {
  INSTANCE_NAME: "Fuse Jewelry",
  ORGANIZATION_ID: "fuse-jewelry",
  INSTANCE_API_KEY: "a".repeat(64),
  SUPABASE_DB_URL: "postgresql://user:pass@db.example.supabase.co:5432/postgres",
};

describe("loadInstanceConfig", () => {
  it("applies defaults", () => {
    const config = loadInstanceConfig(valid);
    expect(config).toMatchObject({ PORT: 8080, MIGRATE_ON_START: true, DOC_REGISTRY_IDS: [], ENABLED_DEPARTMENTS: [], ENABLED_WRITES: [], ENABLED_INTEGRATIONS: [], SYNC_INTERVAL_MINUTES: 60 });
  });

  it("parses the documentation registry list", () => {
    expect(loadInstanceConfig({ ...valid, DOC_REGISTRY_IDS: "a, b,,c " }).DOC_REGISTRY_IDS).toEqual(["a", "b", "c"]);
  });

  it("requires a long API key", () => {
    expect(() => loadInstanceConfig({ ...valid, INSTANCE_API_KEY: "short" })).toThrow(/INSTANCE_API_KEY/);
  });

  it("requires a slug-style organization id", () => {
    expect(() => loadInstanceConfig({ ...valid, ORGANIZATION_ID: "Fuse Jewelry" })).toThrow(/ORGANIZATION_ID/);
  });

  it("never echoes secret values in errors", () => {
    const secret = "postgresql-not-a-url-but-a-secret";
    try {
      loadInstanceConfig({ ...valid, INSTANCE_API_KEY: "tiny-secret", SUPABASE_DB_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("tiny-secret");
    }
  });

  it("reads the enabled departments and rejects unknown ones without echoing values", () => {
    expect(loadInstanceConfig({ ...valid, ENABLED_DEPARTMENTS: "sales, repairs" }).ENABLED_DEPARTMENTS).toEqual(["sales", "repairs"]);
    expect(() => loadInstanceConfig({ ...valid, ENABLED_DEPARTMENTS: "sales,manufacturing" })).toThrow(/ENABLED_DEPARTMENTS: use any of: sales.*, compliance, bench/);
    expect(loadInstanceConfig({ ...valid, ENABLED_DEPARTMENTS: "bench, repairs" }).ENABLED_DEPARTMENTS).toEqual(["bench", "repairs"]);
  });

  it("keeps every integration read-only unless writes are listed", () => {
    expect(loadInstanceConfig({ ...valid, ENABLED_WRITES: "shopify:adjust_inventory, stripe:*" }).ENABLED_WRITES).toEqual([
      "shopify:adjust_inventory",
      "stripe:*",
    ]);
    expect(() => loadInstanceConfig({ ...valid, ENABLED_WRITES: "shopify" })).toThrow(/ENABLED_WRITES: use integration:action/);
  });

  it("reads the enabled integrations and rejects ids outside the catalog", () => {
    expect(loadInstanceConfig({ ...valid, ENABLED_INTEGRATIONS: "shopify, stripe,inventory_pos" }).ENABLED_INTEGRATIONS).toEqual(["shopify", "stripe", "inventory_pos"]);
    expect(() => loadInstanceConfig({ ...valid, ENABLED_INTEGRATIONS: "shopify,constructor" })).toThrow(/ENABLED_INTEGRATIONS: use catalog integration ids/);
  });

  it("keeps the sync interval between 5 minutes and a day", () => {
    expect(loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: "15" }).SYNC_INTERVAL_MINUTES).toBe(15);
    expect(loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: "5" }).SYNC_INTERVAL_MINUTES).toBe(5);
    expect(loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: "1440" }).SYNC_INTERVAL_MINUTES).toBe(1440);
    for (const bad of ["4", "1441", "1.5", "soon"]) expect(() => loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: bad })).toThrow(/SYNC_INTERVAL_MINUTES/);
  });

  it("keeps raw vendor data 30 days unless told otherwise, from 1 to 365 days", () => {
    expect(loadInstanceConfig(valid).RAW_RETENTION_DAYS).toBe(30);
    expect(loadInstanceConfig({ ...valid, RAW_RETENTION_DAYS: "1" }).RAW_RETENTION_DAYS).toBe(1);
    expect(loadInstanceConfig({ ...valid, RAW_RETENTION_DAYS: "90" }).RAW_RETENTION_DAYS).toBe(90);
    expect(loadInstanceConfig({ ...valid, RAW_RETENTION_DAYS: "365" }).RAW_RETENTION_DAYS).toBe(365);
    for (const bad of ["0", "-1", "366", "1.5", "forever"]) expect(() => loadInstanceConfig({ ...valid, RAW_RETENTION_DAYS: bad })).toThrow(/RAW_RETENTION_DAYS/);
  });
});

describe("loadInstanceConfig: SUPPORT_API_KEY", () => {
  // Built at runtime so no key-shaped literal sits in the repository.
  const key = (length: number) => randomBytes(length).toString("hex").slice(0, length);

  it("is optional: unset or empty leaves support access off", () => {
    expect(loadInstanceConfig(valid).SUPPORT_API_KEY).toBeUndefined();
    expect(loadInstanceConfig({ ...valid, SUPPORT_API_KEY: "" }).SUPPORT_API_KEY).toBeUndefined();
  });

  it("takes a key of 32 characters or more, and turns down 31", () => {
    const support = key(32);
    expect(loadInstanceConfig({ ...valid, SUPPORT_API_KEY: support }).SUPPORT_API_KEY).toBe(support);
    const long = key(64);
    expect(loadInstanceConfig({ ...valid, SUPPORT_API_KEY: long }).SUPPORT_API_KEY).toBe(long);
    const short = key(31);
    expect(() => loadInstanceConfig({ ...valid, SUPPORT_API_KEY: short })).toThrow(/SUPPORT_API_KEY: use at least 32 random characters/);
  });

  it("must differ from the instance key, without echoing either", () => {
    const shared = key(64);
    let message = "";
    try {
      loadInstanceConfig({ ...valid, INSTANCE_API_KEY: shared, SUPPORT_API_KEY: shared });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/Invalid instance configuration: SUPPORT_API_KEY: must differ from INSTANCE_API_KEY/);
    expect(message).not.toContain(shared);
    // Compared exactly, case included.
    const mixed = `A${shared.slice(1)}`;
    expect(() => loadInstanceConfig({ ...valid, INSTANCE_API_KEY: mixed, SUPPORT_API_KEY: mixed })).toThrow(/SUPPORT_API_KEY: must differ from INSTANCE_API_KEY/);
    expect(loadInstanceConfig({ ...valid, INSTANCE_API_KEY: mixed, SUPPORT_API_KEY: mixed.toLowerCase() }).SUPPORT_API_KEY).toBe(mixed.toLowerCase());
    // One character apart is a different key.
    const other = `${shared.slice(0, -1)}${shared.endsWith("a") ? "b" : "a"}`;
    expect(loadInstanceConfig({ ...valid, INSTANCE_API_KEY: shared, SUPPORT_API_KEY: other }).SUPPORT_API_KEY).toBe(other);
  });
});

describe("daily brief settings", () => {
  const base = { INSTANCE_NAME: "Example Jewelers", ORGANIZATION_ID: "example-jewelers", INSTANCE_API_KEY: "b".repeat(64), SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres" };

  it("defaults to 7:00 in New York with no webhook", () => {
    const config = loadInstanceConfig(base);
    expect(config).toMatchObject({ STORE_TIME_ZONE: "America/New_York", BRIEF_HOUR: 7 });
    expect(config.BRIEF_WEBHOOK_URL).toBeUndefined();
    expect(loadInstanceConfig({ ...base, BRIEF_WEBHOOK_URL: "" }).BRIEF_WEBHOOK_URL).toBeUndefined();
  });

  it("takes a real time zone and a whole hour from 0 to 23", () => {
    expect(loadInstanceConfig({ ...base, STORE_TIME_ZONE: "America/Los_Angeles", BRIEF_HOUR: "0" })).toMatchObject({ STORE_TIME_ZONE: "America/Los_Angeles", BRIEF_HOUR: 0 });
    expect(loadInstanceConfig({ ...base, BRIEF_HOUR: "23" }).BRIEF_HOUR).toBe(23);
    expect(() => loadInstanceConfig({ ...base, STORE_TIME_ZONE: "Eastern" })).toThrow(/STORE_TIME_ZONE: use an IANA time zone/);
    for (const hour of ["24", "-1", "7.5", "seven"]) expect(() => loadInstanceConfig({ ...base, BRIEF_HOUR: hour }), hour).toThrow(/BRIEF_HOUR/);
  });

  it("takes only an https webhook, and never echoes it", () => {
    const url = "https://hooks.example.test/services/T000/B000/abcdef";
    expect(loadInstanceConfig({ ...base, BRIEF_WEBHOOK_URL: url }).BRIEF_WEBHOOK_URL).toBe(url);
    const plain = "http://hooks.example.test/services/T000/B000/secretpart";
    expect(() => loadInstanceConfig({ ...base, BRIEF_WEBHOOK_URL: plain })).toThrow(/BRIEF_WEBHOOK_URL/);
    try {
      loadInstanceConfig({ ...base, BRIEF_WEBHOOK_URL: plain });
    } catch (error) {
      expect(String(error)).not.toContain("secretpart");
    }
  });
});

describe("store hours settings", () => {
  const base = { INSTANCE_NAME: "Example Jewelers", ORGANIZATION_ID: "example-jewelers", INSTANCE_API_KEY: "b".repeat(64), SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres" };
  const ten = [{ open: 600, close: 1080 }];

  it("defaults to Monday to Saturday, 10:00 to 18:00, no closed dates and a 4-hour wait", () => {
    const config = loadInstanceConfig(base);
    expect(config.STORE_HOURS).toEqual([[], ten, ten, ten, ten, ten, ten]);
    expect(config.STORE_CLOSED_DATES).toEqual([]);
    expect(config.AWAITING_REPLY_HOURS).toBe(4);
    expect(instanceStoreHours(config)).toEqual(STORE_HOURS);
    // Empty is the same as unset.
    expect(instanceStoreHours(loadInstanceConfig({ ...base, STORE_HOURS: "", STORE_CLOSED_DATES: "", AWAITING_REPLY_HOURS: "" }))).toEqual(STORE_HOURS);
  });

  it("reads the store's own hours, closed dates and wait, on STORE_TIME_ZONE's clock", () => {
    const config = loadInstanceConfig({
      ...base,
      STORE_TIME_ZONE: "America/Denver",
      STORE_HOURS: "Mon-Fri 10:00-18:00; sat 10:00-13:00, 14:00-17:00; sun closed",
      STORE_CLOSED_DATES: "2026-12-25, 2026-11-26",
      AWAITING_REPLY_HOURS: "6",
    });
    expect(config.AWAITING_REPLY_HOURS).toBe(6);
    expect(instanceStoreHours(config)).toEqual({
      timeZone: "America/Denver",
      week: [[], ten, ten, ten, ten, ten, [{ open: 600, close: 780 }, { open: 840, close: 1020 }]],
      closedDates: ["2026-11-26", "2026-12-25"],
    });
    expect(loadInstanceConfig({ ...base, AWAITING_REPLY_HOURS: "1" }).AWAITING_REPLY_HOURS).toBe(1);
    expect(loadInstanceConfig({ ...base, AWAITING_REPLY_HOURS: "72" }).AWAITING_REPLY_HOURS).toBe(72);
  });

  it("rejects hours it can't read, naming the setting and the bad part", () => {
    expect(() => loadInstanceConfig({ ...base, STORE_HOURS: "mon-fri 10:00-18:00; tues 10:00-14:00" })).toThrow(
      'Invalid instance configuration: STORE_HOURS: "tues" in "tues 10:00-14:00" isn\'t a day; use mon, tue, wed, thu, fri, sat or sun',
    );
    expect(() => loadInstanceConfig({ ...base, STORE_HOURS: "fri 22:00-02:00" })).toThrow(/STORE_HOURS: "22:00-02:00" in "fri 22:00-02:00" runs past midnight/);
    expect(() => loadInstanceConfig({ ...base, STORE_HOURS: "sun closed" })).toThrow(/STORE_HOURS: the store is never open/);
    expect(() => loadInstanceConfig({ ...base, STORE_CLOSED_DATES: "2026-12-25, 12/26/2026" })).toThrow(
      'Invalid instance configuration: STORE_CLOSED_DATES: "12/26/2026" isn\'t a date; use YYYY-MM-DD, e.g. 2026-12-25',
    );
    for (const hours of ["0", "73", "1.5", "four"]) expect(() => loadInstanceConfig({ ...base, AWAITING_REPLY_HOURS: hours }), hours).toThrow(/AWAITING_REPLY_HOURS/);
    // Every bad setting is named at once.
    expect(() => loadInstanceConfig({ ...base, STORE_HOURS: "daily", STORE_CLOSED_DATES: "soon", STORE_TIME_ZONE: "Mountain" })).toThrow(
      /STORE_TIME_ZONE: use an IANA time zone.*; STORE_HOURS: "daily" has no hours.*; STORE_CLOSED_DATES: "soon" isn't a date/,
    );
  });
});

describe("bench settings", () => {
  const base = { INSTANCE_NAME: "Example Jewelers", ORGANIZATION_ID: "example-jewelers", INSTANCE_API_KEY: "b".repeat(64), SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres" };

  it("keeps the bench rules' defaults when unset or empty", () => {
    for (const env of [base, { ...base, BENCH_STAGE_LIMIT_DAYS: "", BENCH_METAL_LOSS_PERCENT: "" }]) {
      const config = loadInstanceConfig(env);
      expect(config.BENCH_STAGE_LIMIT_DAYS).toEqual({});
      expect(config.BENCH_METAL_LOSS_PERCENT).toBe(3);
      expect(instanceBenchSettings(config)).toEqual({ stageLimitDays: {}, metalLossShare: 0.03 });
    }
  });

  it("reads the workshop's own stage limits and metal loss tolerance", () => {
    const config = loadInstanceConfig({ ...base, BENCH_STAGE_LIMIT_DAYS: "5, casting=2", BENCH_METAL_LOSS_PERCENT: "2.5" });
    expect(instanceBenchSettings(config)).toEqual({ stageLimitDays: { design: 5, casting: 2, setting: 5, finishing: 5, qc: 5, on_hold: 5 }, metalLossShare: 0.025 });
    expect(loadInstanceConfig({ ...base, BENCH_METAL_LOSS_PERCENT: "50" }).BENCH_METAL_LOSS_PERCENT).toBe(50);
  });

  it("rejects settings it can't read, naming the setting and the bad part", () => {
    expect(() => loadInstanceConfig({ ...base, BENCH_STAGE_LIMIT_DAYS: "polish=3" })).toThrow(
      `Invalid instance configuration: BENCH_STAGE_LIMIT_DAYS: "polish" in "polish=3" isn't a stage; use design, casting, setting, finishing, qc, on_hold`,
    );
    expect(() => loadInstanceConfig({ ...base, BENCH_STAGE_LIMIT_DAYS: "casting=0" })).toThrow(/BENCH_STAGE_LIMIT_DAYS: "casting=0" needs whole days from 1 to 365/);
    for (const percent of ["0", "-1", "50.5", "three"]) expect(() => loadInstanceConfig({ ...base, BENCH_METAL_LOSS_PERCENT: percent }), percent).toThrow(/BENCH_METAL_LOSS_PERCENT/);
  });
});
