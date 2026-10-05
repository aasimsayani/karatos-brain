import { describe, expect, it } from "vitest";
import { IdentityCollisionError, InMemoryStore } from "../src/index.js";

describe("InMemoryStore", () => {
  it("records feedback", async () => {
    const store = new InMemoryStore();
    await store.recordFeedback({
      recommendationId: "rec_1",
      organizationId: "org",
      outcome: "accepted",
      actor: "owner",
      recordedAt: "2026-10-01T00:00:00Z",
    });
    expect(store.feedback).toHaveLength(1);
  });

  it("only returns the requested organization's signals", async () => {
    const store = new InMemoryStore();
    const signal = (id: string, organizationId: string) => ({
      id,
      organizationId,
      kind: "k",
      subject: { kind: "order" as const, id },
      value: 1,
      confidence: 1,
      derivedFromEventIds: [],
      observedAt: "2026-10-01T00:00:00Z",
    });
    await store.appendSignals([signal("a", "org-1"), signal("b", "org-2"), signal("c", "org-1")]);
    expect((await store.recentSignals("org-1", 10)).map((s) => s.id)).toEqual(["a", "c"]);
    expect((await store.recentSignals("org-1", 1)).map((s) => s.id)).toEqual(["c"]);
  });

  it("links identities and refuses collisions", async () => {
    const store = new InMemoryStore();
    const link = { organizationId: "org", source: "shopify", externalId: "c1", entity: { kind: "customer", id: "cust_1" } };
    await store.linkIdentity(link);
    await store.linkIdentity(link);
    expect(await store.resolveIdentity("org", "shopify", "c1")).toEqual({ kind: "customer", id: "cust_1" });
    expect(await store.resolveIdentity("org", "shopify", "nope")).toBeNull();
    await expect(store.linkIdentity({ ...link, entity: { kind: "customer", id: "cust_2" } })).rejects.toBeInstanceOf(
      IdentityCollisionError,
    );
  });

  it("keeps the newest entity version and merges provenance", async () => {
    const store = new InMemoryStore();
    const base = { ref: { kind: "order", id: "1" }, organizationId: "org" };
    await store.upsertEntities([{ ...base, attributes: { v: 2 }, sourceEventIds: ["b"], updatedAt: "2026-10-02T00:00:00Z" }]);
    await store.upsertEntities([{ ...base, attributes: { v: 1 }, sourceEventIds: ["a"], updatedAt: "2026-10-01T00:00:00Z" }]);
    await store.upsertEntities([{ ...base, attributes: { v: 3 }, sourceEventIds: ["c"], updatedAt: "2026-10-03T00:00:00Z" }]);
    expect(await store.getEntity("org", "order", "1")).toMatchObject({ attributes: { v: 3 }, sourceEventIds: ["b", "c"] });
    expect(await store.getEntity("org", "order", "2")).toBeNull();
  });

  it("lists recommendations newest first and finds one by id", async () => {
    const store = new InMemoryStore();
    const rec = (id: string, organizationId = "org") => ({
      id,
      organizationId,
      summary: id,
      confidence: 1,
      expectedImpact: "",
      provenance: { eventIds: [], signalIds: [], documentIds: [] },
      degraded: false,
      createdAt: "2026-10-01T00:00:00Z",
    });
    await store.saveRecommendations([rec("a"), rec("b"), rec("x", "other")]);
    expect((await store.listRecommendations("org", 10)).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await store.getRecommendation("org", "a"))?.id).toBe("a");
    expect(await store.getRecommendation("org", "x")).toBeNull();
  });
});
