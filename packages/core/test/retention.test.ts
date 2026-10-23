import { describe, expect, it } from "vitest";
import {
  assertRetentionDays,
  BrainPipeline,
  clearedPayload,
  DEFAULT_RAW_RETENTION_DAYS,
  DeadLetteredError,
  InMemoryStore,
  isClearedPayload,
  isRawExpired,
  parseEvent,
  rawRetentionCutoff,
  sha256Json,
  sourceReferenceFor,
  type EventEnvelope,
  type Normalizer,
  type Reasoner,
  type SignalExtractor,
} from "../src/index.js";

const ORG = "test-jeweler";
const OTHER = "other-jeweler";
const NOW = new Date("2026-10-22T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const order = (n: string, receivedAt: string, organizationId = ORG): EventEnvelope => ({
  id: `evt_${n}`,
  organizationId,
  source: "shopify",
  type: "order.created",
  occurredAt: receivedAt,
  receivedAt,
  idempotencyKey: `shopify:order:${n}:v1`,
  payload: { orderId: `shopify:order:${n}`, totalCents: 125_00, note: "raw vendor detail" },
});

const normalizer: Normalizer = {
  name: "orders",
  supports: (e) => e.type === "order.created",
  normalize: (e) => [
    {
      ref: { kind: "order", id: String(e.payload.orderId) },
      organizationId: e.organizationId,
      attributes: { totalCents: e.payload.totalCents },
      sourceEventIds: [e.id],
      updatedAt: e.occurredAt,
    },
  ],
};

const extractor: SignalExtractor = {
  name: "sales",
  extract: (entities, e) =>
    entities.map((entity) => ({
      id: `sig_${e.id}`,
      organizationId: e.organizationId,
      kind: "sale",
      subject: entity.ref,
      value: Number(entity.attributes.totalCents),
      confidence: 1,
      derivedFromEventIds: [e.id],
      observedAt: e.occurredAt,
    })),
};

const reasoner: Reasoner = {
  name: "restock",
  reason: ({ organizationId, signals, now }) => [
    {
      id: `rec_${organizationId}`,
      organizationId,
      summary: "Restock the best seller",
      confidence: 0.8,
      expectedImpact: "more sales",
      provenance: { eventIds: signals.flatMap((s) => s.derivedFromEventIds), signalIds: signals.map((s) => s.id), documentIds: [] },
      degraded: false,
      createdAt: now,
    },
  ],
};

async function scenario() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [normalizer],
    extractors: [extractor],
    reasoners: [reasoner],
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => NOW,
  });
  const old = order("1", ago(30 * DAY + 1));
  const boundary = order("2", ago(30 * DAY));
  const fresh = order("3", ago(DAY));
  const otherOrg = order("4", ago(90 * DAY), OTHER);
  for (const e of [old, boundary, fresh, otherOrg]) await pipeline.ingest(e);
  await pipeline.reason(ORG);
  return { memory, pipeline, old, boundary, fresh, otherOrg };
}

const snapshot = (m: InMemoryStore) =>
  structuredClone({
    entities: [...m.entities.entries()],
    signals: m.signals,
    recommendations: m.recommendations,
    reasoningRuns: m.reasoningRuns,
    identities: [...m.identities.entries()],
    checkpoints: [...m.checkpoints.entries()],
    feedback: m.feedback,
  });

describe("retention policy", () => {
  it("keeps raw data for 30 days by default and clears it only once it is older", () => {
    expect(DEFAULT_RAW_RETENTION_DAYS).toBe(30);
    expect(rawRetentionCutoff(NOW).toISOString()).toBe(ago(30 * DAY));
    expect(isRawExpired(ago(30 * DAY), NOW)).toBe(false);
    expect(isRawExpired(ago(30 * DAY + 1), NOW)).toBe(true);
    expect(isRawExpired(ago(29 * DAY), NOW)).toBe(false);
    expect(isRawExpired(ago(7 * DAY + 1), NOW, 7)).toBe(true);
    expect(isRawExpired(ago(7 * DAY), NOW, 7)).toBe(false);
  });

  it("accepts whole days from 1 to 365 only", () => {
    expect(assertRetentionDays(1)).toBe(1);
    expect(assertRetentionDays(365)).toBe(365);
    for (const bad of [0, 366, 1.5, -30, Number.NaN]) expect(() => assertRetentionDays(bad)).toThrow(RangeError);
    expect(() => rawRetentionCutoff(NOW, 0)).toThrow(/1 to 365/);
  });

  it("marks cleared payloads with a small tombstone", () => {
    expect(clearedPayload(NOW)).toEqual({ cleared: true, at: NOW.toISOString(), reason: "retention" });
    expect(isClearedPayload(clearedPayload(NOW))).toBe(true);
    for (const v of [null, "x", { cleared: true }, { cleared: "true", at: "x", reason: "retention" }, { cleared: true, at: 1, reason: "retention" }])
      expect(isClearedPayload(v)).toBe(false);
  });

  it("hashes JSON the same whatever the key order", () => {
    expect(sha256Json({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(sha256Json({ b: [{ d: 3, c: 2 }], a: 1 }));
    expect(sha256Json({ a: 1 })).not.toBe(sha256Json({ a: 2 }));
    expect(sha256Json(undefined)).toBe(sha256Json(null));
    expect(sha256Json({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds the source record: declared, else the source's own id in the payload, else the idempotency key", () => {
    const base = order("9", NOW.toISOString());
    expect(sourceReferenceFor(base)).toEqual({ system: "shopify", recordId: "shopify:order:9" });
    expect(sourceReferenceFor({ ...base, sourceRecord: { id: "9", url: "https://admin.example.test/orders/9" } })).toEqual({
      system: "shopify",
      recordId: "9",
      url: "https://admin.example.test/orders/9",
    });
    expect(sourceReferenceFor({ ...base, sourceRecord: { id: "9" } })).toEqual({ system: "shopify", recordId: "9" });
    expect(sourceReferenceFor({ ...base, payload: { orderId: "pos:x", other: "shopify:" } })).toEqual({ system: "shopify", recordId: "shopify:order:9:v1" });
  });

  it("lets a connector declare the vendor record, with an https link only", () => {
    const base = order("9", NOW.toISOString());
    expect(parseEvent({ ...base, sourceRecord: { id: "9", url: "https://admin.example.test/orders/9" } }).sourceRecord?.id).toBe("9");
    expect(() => parseEvent({ ...base, sourceRecord: { id: "9", url: "javascript:alert(1)" } })).toThrow();
    expect(() => parseEvent({ ...base, sourceRecord: { id: "9", url: "http://admin.example.test/orders/9" } })).toThrow();
    expect(() => parseEvent({ ...base, sourceRecord: { id: "" } })).toThrow();
  });
});

describe("InMemoryStore.purgeRawData", () => {
  it("clears payloads older than the window and keeps the one exactly 30 days old", async () => {
    const { memory, old, boundary, fresh } = await scenario();
    const result = await memory.purgeRawData(ORG, NOW);
    expect(result).toEqual({
      organizationId: ORG,
      ranAt: NOW.toISOString(),
      cutoff: ago(30 * DAY),
      retentionDays: 30,
      events: 1,
      deadLetters: 0,
      fileImports: 0,
    });
    const cleared = await memory.getEvent(ORG, old.id);
    expect(cleared).toEqual({
      ...old,
      payload: { cleared: true, at: NOW.toISOString(), reason: "retention" },
      sourceRef: { system: "shopify", recordId: "shopify:order:1" },
      payloadSha256: sha256Json(old.payload),
      payloadClearedAt: NOW.toISOString(),
    });
    expect(cleared?.idempotencyKey).toBe(old.idempotencyKey);
    expect((await memory.getEvent(ORG, boundary.id))?.payload).toEqual(boundary.payload);
    expect((await memory.getEvent(ORG, boundary.id))?.payloadClearedAt).toBeNull();
    expect((await memory.getEvent(ORG, fresh.id))?.payload).toEqual(fresh.payload);
    expect(memory.events).toHaveLength(4);
  });

  it("honours a shorter window", async () => {
    const { memory, fresh } = await scenario();
    expect((await memory.purgeRawData(ORG, NOW, 1)).events).toBe(2);
    expect((await memory.getEvent(ORG, fresh.id))?.payloadClearedAt).toBeNull();
    await expect(memory.purgeRawData(ORG, NOW, 366)).rejects.toThrow(RangeError);
  });

  it("leaves entities, signals, recommendations and runs untouched", async () => {
    const { memory } = await scenario();
    const before = snapshot(memory);
    expect(before.entities.length).toBe(4);
    expect(before.signals.length).toBe(4);
    await memory.purgeRawData(ORG, NOW);
    expect(snapshot(memory)).toEqual(before);
  });

  it("still treats a replay of a cleared event as a duplicate", async () => {
    const { memory, pipeline, old } = await scenario();
    await memory.purgeRawData(ORG, NOW);
    const replay = await pipeline.ingest({ ...old, id: "evt_replayed" });
    expect(replay.duplicate).toBe(true);
    expect(memory.events).toHaveLength(4);
    expect(await memory.getEvent(ORG, "evt_replayed")).toBeNull();
  });

  it("keeps signal and recommendation provenance resolvable to the source record", async () => {
    const { memory, old } = await scenario();
    await memory.purgeRawData(ORG, NOW);
    const signal = memory.signals.find((s) => s.id === `sig_${old.id}`)!;
    const recommendation = (await memory.getRecommendation(ORG, `rec_${ORG}`))!;
    expect(recommendation.provenance.eventIds).toContain(old.id);
    for (const id of [...signal.derivedFromEventIds, ...recommendation.provenance.eventIds]) {
      const stored = await memory.getEvent(ORG, id);
      expect(stored?.sourceRef.system).toBe("shopify");
      expect(stored?.sourceRef.recordId).toMatch(/^shopify:order:\d$/);
    }
    expect((await memory.getEvent(ORG, old.id))?.sourceRef).toEqual({ system: "shopify", recordId: "shopify:order:1" });
  });

  it("is idempotent", async () => {
    const { memory } = await scenario();
    await memory.purgeRawData(ORG, NOW);
    const events = structuredClone(memory.events);
    expect(await memory.purgeRawData(ORG, NOW)).toMatchObject({ events: 0, deadLetters: 0 });
    expect(memory.events).toEqual(events);
    // A later run clears what has since aged out, and leaves the earlier tombstone as it was.
    const later = new Date(NOW.getTime() + 1000);
    expect((await memory.purgeRawData(ORG, later)).events).toBe(1);
    expect(memory.events[0]).toEqual(events[0]);
  });

  it("only touches the organization it is asked to", async () => {
    const { memory, otherOrg } = await scenario();
    await memory.purgeRawData(ORG, NOW);
    expect((await memory.getEvent(OTHER, otherOrg.id))?.payload).toEqual(otherOrg.payload);
    expect((await memory.purgeRawData(OTHER, NOW)).events).toBe(1);
    expect(await memory.getEvent(ORG, otherOrg.id)).toBeNull();
  });

  it("clears dead-lettered input past the window, including input that named no organization", async () => {
    const memory = new InMemoryStore();
    let at = ago(31 * DAY);
    const pipeline = new BrainPipeline({
      memory,
      normalizers: [],
      extractors: [],
      reasoners: [],
      documentation: { current: () => ({ documentIds: [], stale: false }) },
      now: () => new Date(at),
    });
    const bad = (organizationId?: string) => pipeline.ingest({ organizationId, source: "shopify", type: "Bad", secretish: "raw" }).catch((e: unknown) => e);
    expect(await bad(ORG)).toBeInstanceOf(DeadLetteredError);
    await bad(undefined);
    await bad(OTHER);
    at = ago(30 * DAY);
    await bad(ORG);
    const result = await memory.purgeRawData(ORG, NOW);
    expect(result.deadLetters).toBe(2);
    expect(memory.deadLetters.map((d) => isClearedPayload(d.raw))).toEqual([true, true, false, false]);
    expect(memory.deadLetters[0]).toMatchObject({ organizationId: ORG, reason: "validation_failed", raw: { cleared: true, reason: "retention" } });
    expect(memory.deadLetters[0]!.issues.length).toBeGreaterThan(0);
    expect((await memory.purgeRawData(ORG, NOW)).deadLetters).toBe(0);
  });

  it("records every run", async () => {
    const { memory } = await scenario();
    await memory.purgeRawData(ORG, NOW);
    await memory.purgeRawData(ORG, NOW);
    expect(memory.retentionRuns.map((r) => r.events)).toEqual([1, 0]);
    expect(memory.retentionRuns[0]).toMatchObject({ organizationId: ORG, retentionDays: 30, ranAt: NOW.toISOString() });
  });

  it("returns null for events it doesn't hold", async () => {
    const memory = new InMemoryStore();
    expect(await memory.getEvent(ORG, "missing")).toBeNull();
  });
});
