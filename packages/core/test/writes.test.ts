import { describe, expect, it } from "vitest";
import {
  InMemoryWriteAuditLog,
  READ_ONLY,
  WriteGate,
  WritesDisabledError,
  invalidWriteEntries,
  writePolicy,
  type WriteAction,
} from "../src/index.js";

const adjust: WriteAction = { integration: "shopify", name: "adjust_inventory", description: "Adjust stock" };
const tag: WriteAction = { integration: "shopify", name: "tag_customer", description: "Tag a customer" };
const now = () => new Date("2026-10-09T12:00:00Z");

function gate(entries: string[]) {
  const audit = new InMemoryWriteAuditLog();
  return { audit, gate: new WriteGate({ organizationId: "demo", policy: writePolicy(entries), audit, now }) };
}

describe("write policy", () => {
  it("is read-only when nothing is enabled", () => {
    expect(writePolicy([]).allows(adjust)).toBe(false);
    expect(READ_ONLY.allows(adjust)).toBe(false);
  });

  it("allows a single action or every action for one integration", () => {
    expect(writePolicy(["shopify:adjust_inventory"]).allows(adjust)).toBe(true);
    expect(writePolicy(["shopify:adjust_inventory"]).allows(tag)).toBe(false);
    expect(writePolicy(["shopify:*"]).allows(tag)).toBe(true);
    expect(writePolicy(["stripe:*"]).allows(adjust)).toBe(false);
  });

  it("rejects malformed entries", () => {
    expect(invalidWriteEntries(["shopify:*", "shopify", "Shopify:x", "a:b:c"])).toEqual(["shopify", "Shopify:x", "a:b:c"]);
    expect(() => writePolicy(["shopify"])).toThrow(/invalid write entries: shopify/);
  });
});

describe("write gate", () => {
  it("refuses and audits a write that is not enabled, without performing it", async () => {
    const { gate: g, audit } = gate([]);
    let performed = false;
    await expect(
      g.run(adjust, "user:owner", async () => {
        performed = true;
      }),
    ).rejects.toBeInstanceOf(WritesDisabledError);
    expect(performed).toBe(false);
    expect(audit.entries).toEqual([
      { organizationId: "demo", integration: "shopify", action: "adjust_inventory", requestedBy: "user:owner", outcome: "refused", at: "2026-10-09T12:00:00.000Z" },
    ]);
  });

  it("performs and audits an enabled write once", async () => {
    const { gate: g, audit } = gate(["shopify:adjust_inventory"]);
    let calls = 0;
    const result = await g.run(adjust, "recommendation:r1", async () => {
      calls += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(audit.entries.map((e) => e.outcome)).toEqual(["performed"]);
  });

  it("audits a failed write and rethrows the error", async () => {
    const { gate: g, audit } = gate(["shopify:*"]);
    await expect(g.run(tag, "user:owner", () => Promise.reject(new Error("429 from Shopify")))).rejects.toThrow("429 from Shopify");
    await expect(g.run(tag, "user:owner", () => Promise.reject("boom"))).rejects.toBe("boom");
    expect(audit.entries.map((e) => [e.outcome, e.error])).toEqual([
      ["failed", "429 from Shopify"],
      ["failed", "boom"],
    ]);
  });

  it("uses the clock when none is given", async () => {
    const audit = new InMemoryWriteAuditLog();
    const g = new WriteGate({ organizationId: "demo", policy: READ_ONLY, audit });
    await expect(g.run(adjust, "user:owner", async () => undefined)).rejects.toThrow(/turned off/);
    expect(Date.parse(audit.entries[0]!.at)).not.toBeNaN();
  });
});
