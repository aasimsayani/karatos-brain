import { describe, expect, it } from "vitest";
import { DeadLetteredError } from "@karatos/core";
import { z } from "zod";
import { combineDepartments, daysBetween, RETAIL_DEPARTMENTS, selectDepartments, type DepartmentModule } from "../src/index.js";
import { daysUntilNext } from "../src/departments/clienteling.js";
import { store } from "./harness.js";

describe("retail departments", () => {
  it("cover every core retail function", () => {
    expect(RETAIL_DEPARTMENTS.map((d) => d.id)).toEqual([
      "sales",
      "inventory",
      "clienteling",
      "repairs",
      "custom_orders",
      "appraisals",
      "buying",
      "metals",
      "marketing",
      "finance",
      "compliance",
    ]);
  });

  it("give every department a name, a purpose and at least one reasoner", () => {
    for (const d of RETAIL_DEPARTMENTS) {
      expect(d.name.length, d.id).toBeGreaterThan(0);
      expect(d.purpose.length, d.id).toBeGreaterThan(20);
      expect(d.reasoners.length, d.id).toBeGreaterThan(0);
    }
  });

  it("use dotted lowercase event types", () => {
    for (const type of Object.keys(combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas)) {
      expect(type).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it("refuse two departments claiming the same event", () => {
    const clash: DepartmentModule = { ...RETAIL_DEPARTMENTS[0]!, id: "clash", events: { "sale.completed": z.object({}) } };
    expect(() => combineDepartments([RETAIL_DEPARTMENTS[0]!, clash])).toThrow(/sale.completed/);
  });

  it("select departments by id", () => {
    expect(selectDepartments([]).length).toBe(RETAIL_DEPARTMENTS.length);
    expect(selectDepartments(["repairs", "sales"]).map((d) => d.id)).toEqual(["sales", "repairs"]);
    expect(() => selectDepartments(["manufacturing"])).toThrow(/manufacturing/);
  });

  it("dead-letter events whose payload is wrong", async () => {
    const s = store();
    await expect(s.send("repair.received", { ticketId: "R1" })).rejects.toBeInstanceOf(DeadLetteredError);
    expect(s.memory.deadLetters[0]?.issues.map((i) => i.path)).toContain("payload.customerId");
  });

  it("never emit the same signal twice for a replayed event", async () => {
    const s = store();
    const payload = { sku: "R-1", title: "Band", category: "wedding_band", costCents: 100, retailPriceCents: 300, quantity: 1 };
    await s.pipeline.ingest({ id: "e1", organizationId: "fuse-jewelry", source: "t", type: "inventory.received", occurredAt: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:00Z", idempotencyKey: "same", payload });
    await s.pipeline.ingest({ id: "e2", organizationId: "fuse-jewelry", source: "t", type: "inventory.received", occurredAt: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:00Z", idempotencyKey: "same", payload });
    expect(s.memory.signals).toHaveLength(1);
  });

  it("produce recommendations whose provenance points at real events", async () => {
    const s = store();
    await s.send("repair.received", {
      ticketId: "R1",
      customerId: "c1",
      itemDescription: "Ring",
      work: "Resize",
      promisedBy: "2026-09-01",
      estimateCents: 5000,
    });
    const [rec] = await s.ask();
    const eventIds = new Set(s.memory.events.map((e) => e.id));
    expect(rec!.provenance.eventIds.every((id) => eventIds.has(id))).toBe(true);
    expect(rec!.provenance.documentIds).toEqual(["retail-playbook"]);
  });
});

describe("date helpers", () => {
  it("count whole days", () => {
    expect(daysBetween("2026-10-01T00:00:00Z", "2026-10-03T12:00:00Z")).toBe(2);
  });

  it("find the next occurrence of a yearly date", () => {
    expect(daysUntilNext(10, 12, "2026-10-02T15:00:00Z")).toBe(10);
    expect(daysUntilNext(10, 2, "2026-10-02T15:00:00Z")).toBe(0);
    expect(daysUntilNext(10, 1, "2026-10-02T15:00:00Z")).toBe(364);
  });
});
