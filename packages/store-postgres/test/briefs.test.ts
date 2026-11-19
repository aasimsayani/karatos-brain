import { describe, expect, it } from "vitest";
import { InMemoryStore, type BriefStore, type EventEnvelope, type MemoryStore, type RawDataRetention } from "@karatos/core";
import { PostgresMemoryStore } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "example-jewelers";
const OTHER = "other-jewelers";

type Store = MemoryStore & BriefStore & RawDataRetention;

async function postgres(): Promise<Store> {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, 'Example Jewelers'), ($2, 'Other Jewelers')", [ORG, OTHER]);
  return new PostgresMemoryStore(client);
}

const stores: [string, () => Promise<Store>][] = [
  ["in memory", async () => new InMemoryStore()],
  ["Postgres", postgres],
];

const event = (id: string, type: string, occurredAt: string, organizationId = ORG): EventEnvelope => ({
  id,
  organizationId,
  source: "shopify",
  type,
  occurredAt,
  receivedAt: "2026-11-19T00:00:00.000Z",
  idempotencyKey: `k_${id}`,
  payload: { totalCents: 100 },
});

describe.each(stores)("event ranges and saved briefs (%s)", (_name, make) => {
  it("reads events of the given types in [from, to), oldest first, ties by id, up to a limit", async () => {
    const store = await make();
    for (const e of [
      event("e3", "sale.completed", "2026-11-18T05:00:00.000Z"),
      event("e2", "sale.completed", "2026-11-18T05:00:00.000Z"),
      event("e1", "sale.returned", "2026-11-18T04:59:59.999Z"),
      event("e4", "sale.returned", "2026-11-18T20:00:00.000Z"),
      event("e5", "inventory.counted", "2026-11-18T20:00:00.000Z"),
      event("e6", "sale.completed", "2026-11-19T05:00:00.000Z"),
      event("e7", "sale.completed", "2026-11-18T12:00:00.000Z", OTHER),
    ]) {
      await store.appendEvent(e);
    }
    const types = ["sale.completed", "sale.returned"];
    const read = (limit = 10) => store.eventsBetween(ORG, types, "2026-11-18T05:00:00.000Z", "2026-11-19T05:00:00.000Z", limit);
    expect((await read()).map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
    expect((await read(2)).map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(await read(0)).toEqual([]);
    expect(await read(-1)).toEqual([]);
    expect((await read(1.9)).map((e) => e.id)).toEqual(["e2"]);
    expect(await store.eventsBetween(ORG, [], "2026-11-18T05:00:00.000Z", "2026-11-19T05:00:00.000Z", 10)).toEqual([]);
    const [first] = await read(1);
    expect(first).toMatchObject({ id: "e2", source: "shopify", occurredAt: "2026-11-18T05:00:00.000Z", payload: { totalCents: 100 }, sourceRef: { system: "shopify", recordId: "k_e2" }, payloadClearedAt: null });
    expect((await store.latestEventBefore(ORG, types, "2026-11-18T05:00:00.000Z"))?.id).toBe("e1");
    expect((await store.latestEventBefore(ORG, types, "2026-11-18T05:00:00.001Z"))?.id).toBe("e3");
    expect(await store.latestEventBefore(ORG, types, "2026-11-18T04:59:59.999Z")).toBeNull();
    expect(await store.latestEventBefore(ORG, [], "2026-11-20T00:00:00.000Z")).toBeNull();
    expect((await store.latestEventBefore(OTHER, types, "2026-11-20T00:00:00.000Z"))?.id).toBe("e7");
  });

  it("returns cleared payloads as cleared", async () => {
    const store = await make();
    await store.appendEvent(event("e1", "sale.completed", "2026-10-01T12:00:00.000Z"));
    await store.purgeRawData(ORG, new Date("2026-12-31T00:00:00.000Z"), 30);
    const [e] = await store.eventsBetween(ORG, ["sale.completed"], "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", 5);
    expect(e!.payloadClearedAt).toBe("2026-12-31T00:00:00.000Z");
    expect(e!.payload).toMatchObject({ cleared: true });
  });

  it("keeps the first brief saved for a day and reads it back", async () => {
    const store = await make();
    const brief = { organizationId: ORG, date: "2026-11-18", generatedAt: "2026-11-19T12:00:00.000Z", brief: { text: "first", sales: { status: "no_data" } } };
    expect(await store.saveBrief(brief)).toBe(true);
    expect(await store.saveBrief({ ...brief, generatedAt: "2026-11-19T13:00:00.000Z", brief: { text: "second" } })).toBe(false);
    expect(await store.getBrief(ORG, "2026-11-18")).toEqual(brief);
    expect(await store.getBrief(ORG, "2026-11-17")).toBeNull();
    expect(await store.getBrief(OTHER, "2026-11-18")).toBeNull();
    expect(await store.saveBrief({ ...brief, organizationId: OTHER })).toBe(true);
  });
});

describe("daily_briefs", () => {
  it("keeps one row per organization and day, isolated by row-level security", async () => {
    const { client } = await freshDatabase();
    await client.query(`
      insert into organizations (id, name) values ('shop-a', 'A'), ('shop-b', 'B');
      insert into daily_briefs (organization_id, day, generated_at, brief) values
        ('shop-a', '2026-11-18', now(), '{}'), ('shop-b', '2026-11-18', now(), '{}');
    `);
    await expect(client.query("insert into daily_briefs (organization_id, day, generated_at, brief) values ('shop-a', '2026-11-18', now(), '{}')")).rejects.toThrow(/duplicate key/);
    await client.query(`
      create role brief_reader;
      grant select, insert on all tables in schema public to brief_reader;
      set role brief_reader;
      select set_config('request.jwt.claims', '{"organization_id": "shop-a"}', false);
    `);
    const { rows } = await client.query<{ organization_id: string }>("select organization_id from daily_briefs");
    expect(rows).toEqual([{ organization_id: "shop-a" }]);
    await expect(client.query("insert into daily_briefs (organization_id, day, generated_at, brief) values ('shop-b', '2026-11-19', now(), '{}')")).rejects.toThrow(/row-level security/);
  });
});
