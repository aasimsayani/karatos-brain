import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/index.js";

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
});
