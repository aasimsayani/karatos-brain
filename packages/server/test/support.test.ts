import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { InMemoryStore, type IntegrationStatus } from "@karatos/core";
import { loadMigrations, migrate, PostgresMemoryStore, type SqlClient } from "@karatos/store-postgres";
import {
  inMemoryDiagnostics,
  MAX_SUPPORT_ERROR_CHARS,
  MAX_SUPPORT_SCRUB_INPUT,
  postgresDiagnostics,
  scrubSupportText,
  supportLabel,
  supportStatus,
  type SupportDiagnostics,
  type SupportStatusOptions,
} from "../src/index.js";

const ORG = "example-jewelers";
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

describe("scrubSupportText", () => {
  it("replaces email addresses", () => {
    expect(scrubSupportText("no customer for pat.lee+vip@example.test here")).toBe("no customer for [email] here");
    expect(scrubSupportText("pat at example.test")).toBe("pat at example.test");
  });

  it("reads an address as text before the last @ and a dot with text on both sides after it", () => {
    expect(scrubSupportText("to a@b.co now")).toBe("to [email] now");
    expect(scrubSupportText("to a@b@c.co now")).toBe("to [email] now");
    expect(scrubSupportText("to @b.co now")).toBe("to @b.co now");
    expect(scrubSupportText("to a@.co now")).toBe("to a@.co now");
    expect(scrubSupportText("to a@b. now")).toBe("to a@b. now");
    expect(scrubSupportText("to a@bco now")).toBe("to a@bco now");
    expect(scrubSupportText("to a.b@co now")).toBe("to a.b@co now");
    expect(scrubSupportText("(a@b.co); 'c@d.co'")).toBe("([email]); '[email]'");
    expect(scrubSupportText("to @a@b.co now")).toBe("to [email] now");
    expect(scrubSupportText("a@b.co;x. a@b.co,x. a@b.co:x.")).toBe("[email];x. [email],x. [email]:x.");
  });

  it("cuts vendor text before scrubbing it, and stays fast on long repeated input", () => {
    expect(MAX_SUPPORT_SCRUB_INPUT).toBe(4096);
    const at = (n: number) => `${"ab ".repeat(n).slice(0, n - 6)} a@b.c`;
    expect(scrubSupportText(at(MAX_SUPPORT_SCRUB_INPUT), 10_000).endsWith("[email]")).toBe(true);
    expect(scrubSupportText(at(MAX_SUPPORT_SCRUB_INPUT + 1), 10_000).endsWith("[email]")).toBe(false);
    expect(scrubSupportText(at(MAX_SUPPORT_SCRUB_INPUT + 1), 10_000)).toHaveLength(MAX_SUPPORT_SCRUB_INPUT);
    const started = performance.now();
    for (const filler of ["!", "a", "1 ", "a@", "key", "https://a"]) scrubSupportText(filler.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("replaces bearer and basic credentials", () => {
    expect(scrubSupportText("sent Bearer abc.def and basic dXNlcjpwYXNz")).toBe("sent Bearer [redacted] and basic [redacted]");
  });

  it("keeps only the host of a URL", () => {
    expect(scrubSupportText("GET https://api.vendor.test/v1/customers/pat-lee?page=2 failed")).toBe("GET https://api.vendor.test/[redacted] failed");
    expect(scrubSupportText("see http://vendor.test")).toBe("see http://vendor.test/[redacted]");
  });

  it("replaces the value of anything named like a secret", () => {
    for (const name of ["api_key", "access_token", "client_secret", "password", "pwd", "signature", "sig", "Authorization", "auth", "session", "cookie", "x-api-key"]) {
      expect(scrubSupportText(`bad ${name}=abc&next`), name).toBe(`bad ${name}=[redacted]&next`);
      expect(scrubSupportText(`bad ${name}: "two words"`), name).toBe(`bad ${name}: [redacted]`);
    }
    // A word that only contains a secret-like name, or isn't followed by a value, stays.
    expect(scrubSupportText("AuthError: vendor said no")).toBe("AuthError: vendor said no");
    expect(scrubSupportText("token expired")).toBe("token expired");
  });

  it("replaces key-shaped runs: 20 or more characters with letters and digits, or 32 or more of anything key-like", () => {
    const mixed = (n: number) => `a1${"b".repeat(n - 2)}`;
    expect(scrubSupportText(`x ${mixed(19)} y`)).toBe(`x ${mixed(19)} y`);
    expect(scrubSupportText(`x ${mixed(20)} y`)).toBe("x [redacted] y");
    expect(scrubSupportText(`x ${"c".repeat(31)} y`)).toBe(`x ${"c".repeat(31)} y`);
    expect(scrubSupportText(`x ${"c".repeat(32)} y`)).toBe("x [redacted] y");
    // Built at runtime: a random hex key.
    const key = randomBytes(24).toString("hex");
    expect(scrubSupportText(`rejected ${key}`)).toBe("rejected [redacted]");
  });

  it("replaces numbers of six or more digits, keeping shorter ones and dates", () => {
    expect(scrubSupportText("status 50312 at 2026-11-12")).toBe("status 50312 at 2026-11-12");
    expect(scrubSupportText("account 503121 missing")).toBe("account [number] missing");
    expect(scrubSupportText("call 555 010 4477")).toBe("call [number]");
  });

  it("drops control characters and collapses spacing", () => {
    expect(scrubSupportText("  line one\n\tline\u0000two  ")).toBe("line one line two");
  });

  it("drops the whole control range, DEL included, and collapses runs of plain spaces", () => {
    expect(scrubSupportText("a\u001fb\u007fc\u001b[31md")).toBe("a b c [31md");
    expect(scrubSupportText("one   two")).toBe("one two");
  });

  it("replaces every address, whatever its case, and keeps the delimiters around it", () => {
    expect(scrubSupportText("to <pat@example.test>, mailto:lee@example.test and Kim.Lee@Example.test")).toBe("to <[email]>, mailto:[email] and [email]");
    // Without a dot after the @ it isn't an address.
    expect(scrubSupportText("icon@2x missing")).toBe("icon@2x missing");
  });

  it("replaces credentials however many spaces follow the scheme", () => {
    expect(scrubSupportText("sent Bearer   abc.def")).toBe("sent Bearer [redacted]");
  });

  it("keeps only the host of a URL with a query or fragment straight after the host, in any case", () => {
    expect(scrubSupportText("GET https://vendor.test?customer=pat-lee failed")).toBe("GET https://vendor.test/[redacted] failed");
    expect(scrubSupportText("see https://vendor.test#pat-lee")).toBe("see https://vendor.test/[redacted]");
    expect(scrubSupportText("GET HTTPS://Vendor.test/customers/pat-lee")).toBe("GET HTTPS://Vendor.test/[redacted]");
  });

  it("replaces a secret-named value however it is spaced, quoted or ended", () => {
    expect(scrubSupportText("bad passwd=abc&next")).toBe("bad passwd=[redacted]&next");
    expect(scrubSupportText("bad api_key = abc next")).toBe("bad api_key = [redacted] next");
    expect(scrubSupportText("bad token: 'two words' next")).toBe("bad token: [redacted] next");
    expect(scrubSupportText("bad token=abc,next and key=abc;next")).toBe("bad token=[redacted],next and key=[redacted];next");
    expect(scrubSupportText('bad token=ab"cd next')).toBe("bad token=[redacted] next");
  });

  it("treats +, /, = and . as part of a key-shaped run", () => {
    // Built at runtime: pieces too short to be redacted alone.
    const pieces = ["Ab3", "Xy9", "Qr5", "Mn7", "Lp2", "Kd8", "Zw4"];
    expect(scrubSupportText(`rejected ${pieces.join("+")}`)).toBe("rejected [redacted]");
    expect(scrubSupportText(`rejected ${pieces.join("/")}==`)).toBe("rejected [redacted]");
    expect(scrubSupportText(`rejected ${pieces.join(".")}`)).toBe("rejected [redacted]");
  });

  it("counts digits, not characters, and treats a date followed by more digits as a number", () => {
    expect(scrubSupportText("call 555-010-4477")).toBe("call [number]");
    expect(scrubSupportText("lot 12 345 ok")).toBe("lot 12 345 ok");
    expect(scrubSupportText("lot 12 3456 ok")).toBe("lot [number] ok");
    expect(scrubSupportText("on 2026-11-12 503121 failed")).toBe("on [number] failed");
  });

  it("caps the result at 200 characters by default, keeping exactly 200", () => {
    expect(MAX_SUPPORT_ERROR_CHARS).toBe(200);
    const at = `${"abcd ".repeat(40).trim()}z`;
    expect(at).toHaveLength(200);
    expect(scrubSupportText(at)).toBe(at);
    const over = `${at}q`;
    expect(scrubSupportText(over)).toBe(`${at}…`);
    expect(scrubSupportText("abcdef", 5)).toBe("abcde…");
    expect(scrubSupportText("abcde", 5)).toBe("abcde");
  });
});

describe("supportLabel", () => {
  it("shows lowercase names up to 64 characters and groups anything else", () => {
    expect(supportLabel("shopify")).toBe("shopify");
    expect(supportLabel("bank_statements.v2-a")).toBe("bank_statements.v2-a");
    expect(supportLabel(`a${"b".repeat(63)}`)).toBe(`a${"b".repeat(63)}`);
    expect(supportLabel(`a${"b".repeat(64)}`)).toBe("other");
    expect(supportLabel("Pat Lee")).toBe("other");
    expect(supportLabel("-shopify")).toBe("other");
    expect(supportLabel("")).toBe("other");
    // Lowercase only, from a letter or digit, with no spaces or address characters.
    expect(supportLabel("3pl")).toBe("3pl");
    expect(supportLabel("Shopify")).toBe("other");
    expect(supportLabel("pat lee")).toBe("other");
    expect(supportLabel("pat@example.test")).toBe("other");
    expect(supportLabel("vendor:pat")).toBe("other");
    expect(supportLabel(null)).toBe("unknown");
    expect(supportLabel(undefined)).toBe("unknown");
  });
});

const event = (n: number, receivedAt: string, organizationId = ORG, source = "shopify", type = "order.created") => ({
  id: `evt_${n}`,
  organizationId,
  source,
  type,
  occurredAt: receivedAt,
  receivedAt,
  idempotencyKey: `k${n}`,
  payload: { n },
});

const deadLetter = (n: number, source: string | undefined, organizationId: string | undefined) => ({
  id: `dl_${n}`,
  ...(organizationId ? { organizationId } : {}),
  ...(source ? { source } : {}),
  reason: "validation_failed",
  issues: [],
  raw: {},
  receivedAt: "2026-11-12T00:00:00Z",
});

/** Seeds the same rows into either store and checks the same counts come back. */
async function checkDiagnostics(store: { appendEvent: InMemoryStore["appendEvent"]; appendDeadLetter: InMemoryStore["appendDeadLetter"] }, diagnostics: SupportDiagnostics) {
  await store.appendEvent(event(1, "2026-11-12T00:00:00.000Z"));
  await store.appendEvent(event(2, "2026-11-12T23:59:59.000Z"));
  await store.appendEvent(event(3, "2026-11-11T23:59:59.999Z"));
  await store.appendEvent(event(4, "2026-11-12T08:00:00.000Z", ORG, "stripe", "payment.succeeded"));
  await store.appendDeadLetter(deadLetter(1, "shopify", ORG));
  await store.appendDeadLetter(deadLetter(2, "shopify", ORG));
  await store.appendDeadLetter(deadLetter(3, undefined, undefined));
  const since = new Date("2026-11-12T00:00:00.000Z");
  const sorted = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();
  // Received exactly at `since` counts; a millisecond before doesn't.
  expect(sorted(await diagnostics.eventCountsByDay(ORG, since))).toEqual(
    sorted([
      { day: "2026-11-12", source: "shopify", type: "order.created", count: 2 },
      { day: "2026-11-12", source: "stripe", type: "payment.succeeded", count: 1 },
    ]),
  );
  expect(await diagnostics.eventCountsByDay(ORG, new Date("2026-11-13T00:00:00.001Z"))).toEqual([]);
  expect(sorted(await diagnostics.deadLetterCounts(ORG))).toEqual(
    sorted([
      { source: "shopify", reason: "validation_failed", count: 2 },
      { source: null, reason: "validation_failed", count: 1 },
    ]),
  );
}

describe("inMemoryDiagnostics", () => {
  it("counts this organization's events by day, source and type, and its dead letters", async () => {
    const store = new InMemoryStore();
    await store.appendEvent(event(9, "2026-11-12T10:00:00.000Z", "other-jeweler"));
    await store.appendDeadLetter(deadLetter(9, "shopify", "other-jeweler"));
    await checkDiagnostics(store, inMemoryDiagnostics(store, ["a.sql"]));
    expect(await inMemoryDiagnostics(store, ["a.sql", "b.sql"]).appliedMigrations()).toEqual(["a.sql", "b.sql"]);
    expect(await inMemoryDiagnostics(store).appliedMigrations()).toEqual([]);
  });
});

describe("postgresDiagnostics", () => {
  it("counts the same from Postgres and lists the applied migrations", async () => {
    const db = new PGlite();
    const client: SqlClient = {
      async query<T>(text: string, params?: unknown[]) {
        if (params === undefined || params.length === 0) return { rows: ((await db.exec(text)).at(-1)?.rows ?? []) as T[] };
        return { rows: (await db.query<T>(text, params)).rows };
      },
    };
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    await migrate(client, migrations);
    for (const id of [ORG, "other-jeweler"]) await client.query("insert into organizations (id, name) values ($1, $2)", [id, id]);
    // Days are UTC whatever the session's time zone.
    await client.query("set time zone 'America/New_York'");
    const store = new PostgresMemoryStore(client);
    await store.appendEvent(event(9, "2026-11-12T10:00:00.000Z", "other-jeweler"));
    await store.appendDeadLetter(deadLetter(9, "shopify", "other-jeweler"));
    const diagnostics = postgresDiagnostics(client);
    await checkDiagnostics(store, diagnostics);
    expect(await diagnostics.appliedMigrations()).toEqual(migrations.map((m) => m.name));
    await db.close();
  });
});

describe("supportStatus", () => {
  const diagnostics: SupportDiagnostics = {
    appliedMigrations: async () => [],
    deadLetterCounts: async () => [],
    eventCountsByDay: async () => [
      // Rows that group the same once their names are made safe are added together.
      { day: "2026-11-12", source: "Pat Lee", type: "order.created", count: 2 },
      { day: "2026-11-12", source: "Lee Pat", type: "order.created", count: 3 },
    ],
  };
  const base: SupportStatusOptions = {
    instanceName: "Example Jewelers",
    version: "1.2.3",
    startedAt: new Date("2026-11-12T12:00:00.000Z"),
    retentionDays: 7,
    departments: [],
    enabledIntegrations: ["gia", "gia"],
    diagnostics,
    now: () => new Date("2026-11-12T12:00:01.999Z"),
  };

  it("works with only the required options, and lists each enabled integration once", async () => {
    const status = await supportStatus(ORG, base, []);
    expect(status.instance.uptimeSeconds).toBe(1);
    expect(status.integrations).toEqual([{ id: "gia", configured: false, missingSettings: [], syncing: true, notSyncingReason: null, lastSync: null }]);
    expect(status.events).toEqual({ days: 14, since: "2026-10-30T00:00:00.000Z", total: 5, byDay: [{ day: "2026-11-12", source: "other", type: "order.created", count: 5 }] });
    expect(status.deadLetters).toEqual({ total: 0, bySource: {}, byReason: {} });
  });

  it("never reports negative uptime and takes counts from a successful run", async () => {
    const catalog = [{ id: "gia", configured: true, missingSettings: ["GIA_API_KEY"] }] as IntegrationStatus[];
    const status = await supportStatus(
      ORG,
      {
        ...base,
        now: () => new Date("2026-11-12T11:00:00.000Z"),
        syncStatus: () => [
          { id: "gia", mode: "historical", outcome: "succeeded", startedAt: "s", finishedAt: "f", report: { ingested: 4, duplicates: 3, deadLettered: 2, batches: 1, cursor: "opaque-cursor" } },
        ],
      },
      catalog,
      1,
    );
    expect(status.instance.uptimeSeconds).toBe(0);
    expect(status.integrations[0]).toEqual({
      id: "gia",
      configured: true,
      missingSettings: ["GIA_API_KEY"],
      syncing: true,
      notSyncingReason: null,
      lastSync: { mode: "historical", outcome: "succeeded", startedAt: "s", finishedAt: "f", ingested: 4, duplicates: 3, deadLettered: 2, batches: 1, error: null },
    });
    // The sync cursor is a vendor position, not shown.
    expect(JSON.stringify(status)).not.toContain("opaque-cursor");
    expect(status.events.since).toBe("2026-11-12T00:00:00.000Z");
  });

  it("groups free-text types too, and orders rows by day, then source, then type", async () => {
    const status = await supportStatus(
      ORG,
      {
        ...base,
        diagnostics: {
          ...diagnostics,
          eventCountsByDay: async () => [
            { day: "2026-11-12", source: "stripe", type: "payment.succeeded", count: 1 },
            { day: "2026-11-12", source: "shopify", type: "Pat Lee ordered", count: 1 },
            { day: "2026-11-12", source: "shopify", type: "order.created", count: 2 },
            { day: "2026-11-11", source: "stripe", type: "charge.failed", count: 4 },
          ],
        },
      },
      [],
    );
    expect(status.events.byDay).toEqual([
      { day: "2026-11-11", source: "stripe", type: "charge.failed", count: 4 },
      { day: "2026-11-12", source: "shopify", type: "order.created", count: 2 },
      { day: "2026-11-12", source: "shopify", type: "other", count: 1 },
      { day: "2026-11-12", source: "stripe", type: "payment.succeeded", count: 1 },
    ]);
  });

  it("scrubs and caps a failed run's error", async () => {
    const status = await supportStatus(
      ORG,
      { ...base, syncStatus: () => [{ id: "gia", mode: "incremental", outcome: "failed", startedAt: "s", finishedAt: "f", error: `Error: ${"word ".repeat(100)}pat@example.test` }] },
      [],
    );
    const error = status.integrations[0]!.lastSync!.error!;
    expect(error).toHaveLength(MAX_SUPPORT_ERROR_CHARS + 1);
    expect(error.endsWith("…")).toBe(true);
    expect(error).not.toContain("example.test");
  });
});
