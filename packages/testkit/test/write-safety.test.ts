import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WriteAction, WriteOutcome, WriteProposal, WriteTarget } from "@karatos/core";
import { WriteSafetyError, assertWriteSafety } from "../src/index.js";

/** The audit outcome for a write stopped before sending (an existing value of WriteOutcome). */
const R: WriteOutcome = "refused";

// A synthetic customer record in a demo shop; the action appends one tag.
interface Customer {
  id: string;
  tags: string[];
}

const addTag: WriteAction = { integration: "demo", name: "tag_customer", description: "Add a tag", kind: "append" };

function shop(overrides: Partial<WriteTarget<{ tag: string }, Customer>> = {}) {
  const record: Customer = { id: "c-1", tags: ["vip"] };
  const target: WriteTarget<{ tag: string }, Customer> = {
    schema: z.object({ tag: z.string().min(1).max(40) }),
    fields: ["tags"],
    read: async () => ({ ...record, tags: [...record.tags] }),
    write: async ({ tag }) => {
      record.tags.push(tag);
      return {};
    },
    verify: (after, input, before) => after.id === before.id && after.tags.join(",") === [...before.tags, input.tag].join(","),
    ...overrides,
  };
  return { record, target };
}

const proposal = (overrides: Partial<WriteProposal<{ tag: string }, Customer>> = {}): WriteProposal<{ tag: string }, Customer> => ({
  action: addTag,
  key: "tag-1",
  requestedBy: "recommendation:r1",
  evidence: "recommendation:r1",
  input: { tag: "anniversary" },
  expected: { id: "c-1", tags: ["vip"] },
  approvedBy: "user:owner",
  ...overrides,
});

describe("assertWriteSafety", () => {
  it("passes a careful target and sends the write exactly once", async () => {
    const { record, target } = shop();
    const report = await assertWriteSafety(target, proposal());
    expect(record.tags).toEqual(["vip", "anniversary"]);
    expect(report.result).toMatchObject({ outcome: "verified", replayed: false });
    expect(report.audit.map((e) => e.outcome)).toEqual([R, R, R, R, R, "stale", "capped", "unverified", R, "verified", R]);
    expect(report.audit.at(-2)).toMatchObject({ before: { tags: ["vip"] }, after: { tags: ["vip", "anniversary"] } });
  });

  it("skips the approval check for a draft that needs none", async () => {
    const draft: WriteAction = { ...addTag, name: "draft_tag", kind: "draft", approval: "none" };
    const { target } = shop();
    const { approvedBy: _, ...unapproved } = proposal({ action: draft });
    const report = await assertWriteSafety(target, unapproved, { badInputs: [{ tag: "" }] });
    expect(report.audit.map((e) => e.outcome)).toEqual([R, R, "stale", "capped", "unverified", R, "verified", R]);
  });

  it("fails a proposal with no approver for an action that needs one", async () => {
    const { target } = shop();
    const { approvedBy: _, ...unapproved } = proposal();
    await expect(assertWriteSafety(target, unapproved)).rejects.toThrow(/needs approvedBy/);
  });

  it("fails a target whose schema lets anything through", async () => {
    const { target } = shop({ schema: z.any() as unknown as z.ZodType<{ tag: string }> });
    await expect(assertWriteSafety(target, proposal())).rejects.toThrow(/mis-shaped input: expected WriteShapeError, got TypeError/);
    await expect(assertWriteSafety(shop({ schema: z.any() as unknown as z.ZodType<{ tag: string }> }).target, proposal(), { badInputs: [{ tag: 5 }] })).rejects.toThrow(
      /mis-shaped input: expected WriteShapeError, got the write went through/,
    );
  });

  it("fails a target whose verify trusts every write", async () => {
    const { target } = shop({ verify: () => true });
    const error = await assertWriteSafety(target, proposal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteSafetyError);
    expect((error as Error).message).toMatch(/demo:tag_customer unverified: expected WriteUnverifiedError, got the write went through/);
  });

  it("fails when the proposal itself does not match the record", async () => {
    const { target } = shop();
    await expect(assertWriteSafety(target, proposal({ expected: { id: "c-1", tags: [] } }))).rejects.toThrow(/expected must match what the target reads now/);
    const { target: broken } = shop({ write: () => Promise.reject("vendor said no") });
    await expect(assertWriteSafety(broken, proposal())).rejects.toThrow(/did not verify \(vendor said no\)/);
  });
});
