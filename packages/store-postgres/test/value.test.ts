import { describe, expect, it } from "vitest";
import { readValueReport, type Recommendation, type ValueResult } from "@karatos/core";
import { PostgresMemoryStore } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "org_a";
const FROM = "2026-10-01T00:00:00.000Z";
const TO = "2026-11-01T00:00:00.000Z";

const rec = (id: string, createdAt: string, organizationId = ORG): Recommendation => ({
  id,
  organizationId,
  summary: id,
  confidence: 0.5,
  expectedImpact: "",
  impact: { kind: "makes", lowCents: 100, cents: 200, highCents: 300, basis: "test" },
  provenance: { eventIds: [], signalIds: [], documentIds: [] },
  degraded: false,
  createdAt,
});

const result = (recommendationId: string, cents: number, recordedAt: string, over: Partial<ValueResult> = {}): ValueResult => ({
  recommendationId,
  organizationId: ORG,
  kind: "makes",
  cents,
  source: "measured",
  actor: "karatos",
  recordedAt,
  ...over,
});

async function setup() {
  const { client } = await freshDatabase();
  for (const id of [ORG, "org_b"]) await client.query("insert into organizations (id, name) values ($1, $1)", [id]);
  const store = new PostgresMemoryStore(client);
  await store.saveRecommendations([
    rec("before", "2026-09-30T23:59:59.999Z"),
    rec("first", FROM),
    // Named to sort before "first", so only the time can put it last.
    rec("a_last", "2026-10-31T23:59:59.999Z"),
    rec("after", TO),
    rec("other", "2026-10-02T00:00:00.000Z", "org_b"),
  ]);
  return { client, store };
}

describe("the value ledger in Postgres", () => {
  it("reads the recommendations raised in a period, oldest first, from its first instant up to its end", async () => {
    const { store } = await setup();
    expect((await store.recommendationsBetween(ORG, FROM, TO)).map((r) => r.id)).toEqual(["first", "a_last"]);
  });

  it("reads back feedback, with and without a note, for the recommendations asked about", async () => {
    const { store } = await setup();
    await store.recordFeedback({ recommendationId: "first", organizationId: ORG, outcome: "accepted", actor: "owner", note: "Called her", recordedAt: "2026-10-02T00:00:00.000Z" });
    await store.recordFeedback({ recommendationId: "a_last", organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: "2026-10-01T00:00:00.000Z" });
    await store.recordFeedback({ recommendationId: "before", organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: "2026-10-01T00:00:00.000Z" });
    expect(await store.listFeedback(ORG, ["first", "a_last"])).toEqual([
      { recommendationId: "a_last", organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: "2026-10-01T00:00:00.000Z" },
      { recommendationId: "first", organizationId: ORG, outcome: "accepted", actor: "owner", note: "Called her", recordedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    expect(await store.listFeedback("org_b", ["first"])).toEqual([]);
  });

  it("stores results and reads them back in order, keeping cents exact", async () => {
    const { client, store } = await setup();
    const big = result("first", Number.MAX_SAFE_INTEGER, "2026-10-20T00:00:00.000Z", { note: "A very good month" });
    await store.recordValueResult(big);
    await store.recordValueResult(result("first", 0, "2026-10-10T00:00:00.000Z", { source: "reported", actor: "owner" }));
    await store.recordValueResult(result("a_last", 50, "2026-10-10T00:00:00.000Z"));
    // Read without the index, which would hand rows back in time order by itself.
    await client.query("set enable_indexscan = off; set enable_bitmapscan = off");
    expect(await store.listValueResults(ORG, ["first"])).toEqual([
      result("first", 0, "2026-10-10T00:00:00.000Z", { source: "reported", actor: "owner" }),
      big,
    ]);
    expect(await store.listValueResults("org_b", ["first"])).toEqual([]);
  });

  it("won't store a result that doesn't add up, and the table itself turns down bad rows", async () => {
    const { client, store } = await setup();
    await expect(store.recordValueResult(result("first", -1, "2026-10-10T00:00:00.000Z"))).rejects.toThrow("a result must be whole cents, zero or more");
    const insert = (kind: string, cents: number, source: string, actor: string) =>
      client.query(
        "insert into value_results (organization_id, recommendation_id, kind, cents, source, actor, recorded_at) values ($1, 'first', $2, $3, $4, $5, now())",
        [ORG, kind, cents, source, actor],
      );
    await expect(insert("earns", 1, "measured", "x")).rejects.toThrow();
    await expect(insert("makes", -1, "measured", "x")).rejects.toThrow();
    await expect(insert("makes", 1, "guessed", "x")).rejects.toThrow();
    await expect(insert("makes", 1, "measured", "  ")).rejects.toThrow();
    await expect(
      client.query("insert into value_results (organization_id, recommendation_id, kind, cents, source, actor, recorded_at) values ($1, 'missing', 'makes', 1, 'measured', 'x', now())", [ORG]),
    ).rejects.toThrow();
    await insert("makes", 1, "measured", "x");
    expect((await store.listValueResults(ORG, ["first"])).map((r) => r.cents)).toEqual([1]);
  });

  it("reads cents a driver hands back as a string, as pg does for bigint", async () => {
    const row = { recommendation_id: "r", organization_id: ORG, kind: "saves", cents: "9007199254740991", source: "reported", note: null, actor: "owner", recorded_at: new Date("2026-10-10T00:00:00Z") };
    const store = new PostgresMemoryStore({ query: async <T>() => ({ rows: [row] as T[] }) });
    expect(await store.listValueResults(ORG, ["r"])).toEqual([
      { recommendationId: "r", organizationId: ORG, kind: "saves", cents: Number.MAX_SAFE_INTEGER, source: "reported", actor: "owner", recordedAt: "2026-10-10T00:00:00.000Z" },
    ]);
  });

  it("keeps results to their own organization under row-level security", async () => {
    const { client } = await setup();
    const { rows } = await client.query<{ relrowsecurity: boolean; policies: number }>(
      `select relrowsecurity, (select count(*)::int from pg_policies where tablename = 'value_results') as policies
       from pg_class where relname = 'value_results'`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, policies: 1 });
  });

  it("builds a month's report from the database", async () => {
    const { store } = await setup();
    await store.recordFeedback({ recommendationId: "first", organizationId: ORG, outcome: "accepted", actor: "owner", recordedAt: "2026-10-02T00:00:00.000Z" });
    await store.recordValueResult(result("first", 250, "2026-10-20T00:00:00.000Z"));
    const report = await readValueReport(store, ORG, { from: FROM, to: TO });
    expect(report.shown).toMatchObject({ count: 2, priced: 2 });
    expect(report.approved.count).toBe(1);
    expect(report.returned.cents.makes).toBe(250);
    expect(report.awaiting.count).toBe(0);
  });
});
