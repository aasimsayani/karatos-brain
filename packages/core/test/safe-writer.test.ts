import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_DAILY_WRITE_CAP,
  InMemoryWriteAuditLog,
  InMemoryWriteBreaker,
  InMemoryWriteCapStore,
  InMemoryWriteIdempotencyStore,
  SafeWriter,
  WriteActionInvalidError,
  WriteApprovalRequiredError,
  WriteCapReachedError,
  WriteGate,
  WriteInFlightError,
  WriteShapeError,
  WriteStaleError,
  WriteUnverifiedError,
  WritesDisabledError,
  WritesTrippedError,
  dailyWriteCap,
  requiredApproval,
  sameState,
  undoProposal,
  writeActionProblems,
  writePolicy,
  type WriteAction,
  type WriteApproval,
  type WriteKind,
  type WriteOutcome,
  type WriteProposal,
  type WriteTarget,
} from "../src/index.js";

// Synthetic records only: a demo shop's stock level and its notes.
interface Level {
  sku: string;
  title: string;
  available: number;
}
interface Delta {
  delta: number;
}

const adjust: WriteAction = { integration: "demo", name: "adjust_stock", description: "Adjust stock", kind: "update" };
const DAY = "2026-10-22";

function stockSystem(start = 5) {
  const record: Level = { sku: "SKU-1", title: "Demo ring", available: start };
  const calls = { writes: 0, reads: 0 };
  const target: WriteTarget<Delta, Level> = {
    schema: z.object({ delta: z.number().int().min(-3).max(3) }),
    fields: ["available"],
    read: async () => {
      calls.reads += 1;
      return { ...record };
    },
    write: async ({ delta }) => {
      calls.writes += 1;
      record.available += delta;
      return {};
    },
    verify: (after, input, before) => after.available === before.available + input.delta && after.sku === before.sku && after.title === before.title,
    invert: (_before, input) => ({ delta: -input.delta }),
  };
  return { record, calls, target };
}

function setup(options: { entries?: string[]; approvals?: Record<string, WriteApproval>; clock?: { at: Date } } = {}) {
  const audit = new InMemoryWriteAuditLog();
  const clock = options.clock ?? { at: new Date(`${DAY}T12:00:00Z`) };
  const gate = new WriteGate({ organizationId: "demo-org", policy: writePolicy(options.entries ?? ["demo:*"]), audit, now: () => clock.at });
  const caps = new InMemoryWriteCapStore();
  const breaker = new InMemoryWriteBreaker();
  const idempotency = new InMemoryWriteIdempotencyStore();
  const writer = new SafeWriter({ gate, caps, breaker, idempotency, ...(options.approvals ? { approvals: options.approvals } : {}) });
  return { audit, caps, breaker, writer, clock };
}

function proposal(overrides: Partial<WriteProposal<Delta, Level>> = {}): WriteProposal<Delta, Level> {
  return {
    action: adjust,
    key: "p-1",
    requestedBy: "recommendation:r1",
    evidence: "recommendation:r1",
    input: { delta: 2 },
    expected: { sku: "SKU-1", title: "Demo ring", available: 5 },
    approvedBy: "user:owner",
    ...overrides,
  };
}

/** The audit outcome for a write stopped before sending (an existing value of WriteOutcome). */
const STOPPED: WriteOutcome = "refused";
const outcomes = (audit: InMemoryWriteAuditLog) => audit.entries.map((e) => e.outcome);

describe("action declarations", () => {
  it("accepts drafts, appends and updates and rejects anything else", () => {
    expect(writeActionProblems(adjust)).toEqual([]);
    expect(writeActionProblems({ ...adjust, kind: undefined as unknown as WriteKind })).toEqual([]);
    for (const kind of ["draft", "append"] as const) expect(writeActionProblems({ ...adjust, kind })).toEqual([]);
    expect(writeActionProblems({ ...adjust, kind: "delete" as WriteKind })).toEqual([expect.stringMatching(/unknown write kind "delete"/)]);
  });

  it("allows approval none only for drafts", () => {
    expect(writeActionProblems({ ...adjust, kind: "draft", approval: "none" })).toEqual([]);
    expect(writeActionProblems({ ...adjust, approval: "none" })).toEqual(['approval "none" is only allowed for drafts']);
    expect(writeActionProblems({ ...adjust, kind: "append", approval: "none" })).toHaveLength(1);
    expect(writeActionProblems({ ...adjust, approval: "each" })).toEqual([]);
    expect(writeActionProblems({ ...adjust, approval: "maybe" as WriteApproval })).toEqual(["approval must be each or none"]);
  });

  it("allows a daily cap from 1 to the default only", () => {
    expect(writeActionProblems({ ...adjust, dailyCap: 1 })).toEqual([]);
    expect(writeActionProblems({ ...adjust, dailyCap: DEFAULT_DAILY_WRITE_CAP })).toEqual([]);
    for (const dailyCap of [0, DEFAULT_DAILY_WRITE_CAP + 1, 1.5]) expect(writeActionProblems({ ...adjust, dailyCap })).toHaveLength(1);
    expect(dailyWriteCap(adjust)).toBe(25);
    expect(dailyWriteCap({ ...adjust, dailyCap: 3 })).toBe(3);
  });

  it("requires approval for everything but a draft that declares none, and instances can only raise it", () => {
    expect(requiredApproval(adjust)).toBe("each");
    expect(requiredApproval({ ...adjust, approval: "none" })).toBe("each");
    expect(requiredApproval({ ...adjust, kind: "append", approval: "none" })).toBe("each");
    expect(requiredApproval({ ...adjust, approval: "none", kind: undefined as unknown as WriteKind })).toBe("each");
    expect(requiredApproval({ ...adjust, kind: "draft" })).toBe("each");
    expect(requiredApproval({ ...adjust, kind: "draft", approval: "none" })).toBe("none");
    expect(requiredApproval({ ...adjust, kind: "draft", approval: "none" }, "each")).toBe("each");
    expect(requiredApproval({ ...adjust, kind: "draft", approval: "none" }, "none")).toBe("none");
    expect(requiredApproval(adjust, "none")).toBe("each");
    expect(requiredApproval({ ...adjust, kind: "draft" }, "none")).toBe("each");
  });

  it("rejects to run an unsafely declared action and sends nothing", async () => {
    for (const action of [{ ...adjust, kind: "delete" as WriteKind }, { ...adjust, approval: "none" as const }, { ...adjust, dailyCap: 100 }]) {
      const { writer, audit } = setup();
      const { target, calls } = stockSystem();
      await expect(writer.run(target, proposal({ action, approvedBy: undefined as unknown as string }))).rejects.toBeInstanceOf(WriteActionInvalidError);
      await expect(writer.run(target, proposal({ action }))).rejects.toBeInstanceOf(WriteActionInvalidError);
      expect(calls.writes).toBe(0);
      expect(outcomes(audit)).toEqual([STOPPED, STOPPED]);
    }
  });
});

describe("safe writer", () => {
  it("performs, verifies and audits only the touched fields", async () => {
    const { writer, audit } = setup();
    const { target, calls, record } = stockSystem();
    const result = await writer.run(target, proposal());
    expect(result).toEqual({
      key: "p-1",
      outcome: "verified",
      replayed: false,
      before: { sku: "SKU-1", title: "Demo ring", available: 5 },
      after: { sku: "SKU-1", title: "Demo ring", available: 7 },
    });
    expect(record.available).toBe(7);
    expect(calls.writes).toBe(1);
    expect(audit.entries).toEqual([
      {
        organizationId: "demo-org",
        integration: "demo",
        action: "adjust_stock",
        requestedBy: "recommendation:r1",
        proposalKey: "p-1",
        kind: "update",
        evidence: "recommendation:r1",
        approvedBy: "user:owner",
        outcome: "verified",
        at: `${DAY}T12:00:00.000Z`,
        before: { available: 5 },
        after: { available: 7 },
      },
    ]);
  });

  it("rejects when the instance policy does not allow the action", async () => {
    const { writer, audit } = setup({ entries: ["demo:other_action"] });
    const { target, calls } = stockSystem();
    await expect(writer.run(target, proposal())).rejects.toBeInstanceOf(WritesDisabledError);
    expect(calls).toEqual({ writes: 0, reads: 0 });
    expect(audit.entries).toEqual([expect.objectContaining({ outcome: STOPPED, proposalKey: "p-1", error: expect.stringMatching(/turned off/) })]);
  });

  describe("shape", () => {
    it("rejects input outside the action's limits without reading or writing", async () => {
      const { writer, audit } = setup();
      const { target, calls } = stockSystem();
      const error = await writer.run(target, proposal({ input: { delta: 4 } })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WriteShapeError);
      expect((error as WriteShapeError).issues).toEqual([expect.stringMatching(/^input\.delta: /)]);
      await expect(writer.run(target, proposal({ input: "4" as unknown as Delta }))).rejects.toThrow(/mis-shaped: input: /);
      expect(calls).toEqual({ writes: 0, reads: 0 });
      expect(outcomes(audit)).toEqual([STOPPED, STOPPED]);
    });

    it("rejects a proposal without a key, requester or evidence", async () => {
      const { writer, audit } = setup();
      const { target, calls } = stockSystem();
      for (const bad of [{ key: "" }, { key: "k".repeat(257) }, { requestedBy: " " }, { evidence: "" }, { evidence: 7 as unknown as string }, { requestedBy: "x".repeat(201) }]) {
        await expect(writer.run(target, proposal(bad))).rejects.toBeInstanceOf(WriteShapeError);
      }
      expect(calls.writes).toBe(0);
      expect(audit.entries.at(-2)).toMatchObject({ outcome: STOPPED, evidence: "" });
      expect(audit.entries.at(-1)!.requestedBy).toHaveLength(200);
    });
  });

  describe("approval", () => {
    it("rejects an update nobody approved", async () => {
      const { writer, audit } = setup();
      const { target, calls } = stockSystem();
      const { approvedBy: _, ...unapproved } = proposal();
      await expect(writer.run(target, unapproved)).rejects.toBeInstanceOf(WriteApprovalRequiredError);
      await expect(writer.run(target, proposal({ approvedBy: "  " }))).rejects.toBeInstanceOf(WriteApprovalRequiredError);
      expect(calls).toEqual({ writes: 0, reads: 0 });
      expect(audit.entries.map((e) => [e.outcome, e.approvedBy])).toEqual([
        [STOPPED, undefined],
        [STOPPED, undefined],
      ]);
    });

    it("lets a draft declared approval none through without an approver", async () => {
      const draft: WriteAction = { integration: "demo", name: "draft_note", description: "Draft a note", kind: "draft", approval: "none" };
      const { writer } = setup();
      const { target } = stockSystem();
      const { approvedBy: _, ...unapproved } = proposal({ action: draft });
      await expect(writer.run(target, unapproved)).resolves.toMatchObject({ outcome: "verified" });
    });

    it("never lets an instance lower an action's approval", async () => {
      const { writer } = setup({ approvals: { "demo:adjust_stock": "none", "demo:*": "none" } });
      const { target, calls } = stockSystem();
      const { approvedBy: _, ...unapproved } = proposal();
      await expect(writer.run(target, unapproved)).rejects.toBeInstanceOf(WriteApprovalRequiredError);
      expect(calls.writes).toBe(0);
    });

    it("lets an instance raise a draft's approval, by action or for a whole integration", async () => {
      const draft: WriteAction = { integration: "demo", name: "draft_note", description: "Draft a note", kind: "draft", approval: "none" };
      for (const approvals of [{ "demo:draft_note": "each" as const }, { "demo:*": "each" as const }, { "demo:draft_note": "each" as const, "demo:*": "none" as const }]) {
        const { writer } = setup({ approvals });
        const { target } = stockSystem();
        const { approvedBy: _, ...unapproved } = proposal({ action: draft });
        await expect(writer.run(target, unapproved)).rejects.toBeInstanceOf(WriteApprovalRequiredError);
      }
      const { writer } = setup({ approvals: { "other:*": "each" } });
      expect(writer.approvalFor(draft)).toBe("none");
      expect(setup({ approvals: JSON.parse('{"__proto__":"each"}') }).writer.approvalFor(draft)).toBe("none");
    });
  });

  describe("fresh precondition", () => {
    it("rejects as stale when the record changed since the proposal, and sends nothing", async () => {
      const { writer, audit, caps } = setup();
      const { target, calls, record } = stockSystem();
      record.available = 4; // someone sold one since the proposal was made
      await expect(writer.run(target, proposal())).rejects.toBeInstanceOf(WriteStaleError);
      expect(calls.writes).toBe(0);
      expect(audit.entries).toEqual([expect.objectContaining({ outcome: "stale", before: { available: 4 } })]);
      expect(caps.used("demo-org", "demo:adjust_stock", DAY)).toBe(0);
      // The key was released, so a corrected proposal with the same key can run.
      await expect(writer.run(target, proposal({ expected: { ...record } }))).resolves.toMatchObject({ outcome: "verified", replayed: false });
    });

    it("rejects as stale when any field the proposal saw differs, not only the touched one", async () => {
      const { writer } = setup();
      const { target, calls, record } = stockSystem();
      record.title = "Renamed ring";
      await expect(writer.run(target, proposal())).rejects.toBeInstanceOf(WriteStaleError);
      expect(calls.writes).toBe(0);
    });

    it("rejects when the record cannot be re-read, and gives the attempt back", async () => {
      const { writer, audit, caps } = setup();
      const { target, calls } = stockSystem();
      const failing = { ...target, read: () => Promise.reject(new Error("timeout")) };
      await expect(writer.run(failing, proposal())).rejects.toThrow(/could not re-read the record before writing: timeout/);
      expect(calls.writes).toBe(0);
      expect(outcomes(audit)).toEqual([STOPPED]);
      expect(caps.used("demo-org", "demo:adjust_stock", DAY)).toBe(0);
      await expect(writer.run(target, proposal())).resolves.toMatchObject({ outcome: "verified" });
    });
  });

  describe("daily cap", () => {
    it("rejects writes over the action's own cap and resets the next UTC day", async () => {
      const clock = { at: new Date(`${DAY}T23:00:00Z`) };
      const { writer, audit } = setup({ clock });
      const { target, calls, record } = stockSystem();
      const capped = { ...adjust, dailyCap: 2 };
      const next = (key: string) => proposal({ action: capped, key, input: { delta: 1 }, expected: { ...record } });
      await writer.run(target, next("a"));
      await writer.run(target, next("b"));
      await expect(writer.run(target, next("c"))).rejects.toBeInstanceOf(WriteCapReachedError);
      expect(calls.writes).toBe(2);
      expect(outcomes(audit)).toEqual(["verified", "verified", "capped"]);
      clock.at = new Date("2026-10-23T00:00:01Z");
      await expect(writer.run(target, next("c"))).resolves.toMatchObject({ outcome: "verified" });
    });

    it("caps an action at the default when it declares none", async () => {
      const { writer } = setup();
      const { target, calls, record } = stockSystem();
      const run = (n: number) => writer.run(target, proposal({ key: `k${n}`, input: { delta: n % 2 === 0 ? 1 : -1 }, expected: { ...record } }));
      for (let n = 0; n < DEFAULT_DAILY_WRITE_CAP; n += 1) await run(n);
      await expect(run(99)).rejects.toThrow(/cap of 25 today/);
      expect(calls.writes).toBe(DEFAULT_DAILY_WRITE_CAP);
    });
  });

  describe("idempotency", () => {
    it("returns the earlier result for a replayed key and sends nothing", async () => {
      const { writer, audit } = setup();
      const { target, calls } = stockSystem();
      const first = await writer.run(target, proposal());
      const again = await writer.run(target, proposal());
      expect(again).toEqual({ ...first, replayed: true });
      expect(calls.writes).toBe(1);
      expect(audit.entries.map((e) => [e.outcome, e.error])).toEqual([
        ["verified", undefined],
        [STOPPED, "replayed key: returned the earlier verified result, nothing sent"],
      ]);
    });

    it("keys are per action", async () => {
      const { writer } = setup();
      const { target, calls, record } = stockSystem();
      await writer.run(target, proposal());
      const other = { ...adjust, name: "adjust_other" };
      await writer.run(target, proposal({ action: other, expected: { ...record } }));
      expect(calls.writes).toBe(2);
    });

    it("rejects a second run of a key that is still in flight", async () => {
      const { writer } = setup();
      const { target, calls } = stockSystem();
      let release!: () => void;
      const slow: WriteTarget<Delta, Level> = {
        ...target,
        write: async (input) => {
          await new Promise<void>((resolve) => (release = resolve));
          return target.write(input);
        },
      };
      const first = writer.run(slow, proposal());
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(writer.run(slow, proposal())).rejects.toBeInstanceOf(WriteInFlightError);
      release();
      await first;
      expect(calls.writes).toBe(1);
    });

    it("keeps a failed write's result so a replay never sends it twice", async () => {
      const { writer, audit, breaker } = setup();
      const { target, calls } = stockSystem();
      const failing: WriteTarget<Delta, Level> = { ...target, write: () => Promise.reject(new Error("502 from vendor")) };
      await expect(writer.run(failing, proposal())).rejects.toThrow("502 from vendor");
      const replay = await writer.run(target, proposal());
      expect(replay).toMatchObject({ outcome: "failed", replayed: true, error: "502 from vendor" });
      expect(calls.writes).toBe(0);
      expect(audit.entries[0]).toMatchObject({ outcome: "failed", error: "502 from vendor", before: { available: 5 } });
      expect(await breaker.tripped("demo-org", "demo")).toBeNull();
      await expect(writer.run({ ...target, write: () => Promise.reject("boom") }, proposal({ key: "p-2" }))).rejects.toBe("boom");
    });
  });

  describe("postcondition and breaker", () => {
    it("records unverified and trips the breaker when the change did not land", async () => {
      const { writer, audit, breaker } = setup();
      const { target, record } = stockSystem();
      const silent: WriteTarget<Delta, Level> = { ...target, write: async () => ({ id: "ignored-1" }) };
      await expect(writer.run(silent, proposal())).rejects.toBeInstanceOf(WriteUnverifiedError);
      expect(audit.entries).toEqual([
        expect.objectContaining({ outcome: "unverified", before: { available: 5 }, after: { available: 5 }, createdId: "ignored-1", error: "the record read back does not match the write" }),
      ]);
      expect(await breaker.tripped("demo-org", "demo")).toEqual({ reason: "demo:adjust_stock p-1: the record read back does not match the write", at: `${DAY}T12:00:00.000Z` });
      // Every write for the integration is now off, whatever the action.
      const other = { ...adjust, name: "adjust_other" };
      await expect(writer.run(target, proposal({ action: other, key: "p-2", expected: { ...record } }))).rejects.toBeInstanceOf(WritesTrippedError);
      expect(record.available).toBe(5);
      // The replay reports the unverified result, it never resends.
      await expect(writer.run(target, proposal())).rejects.toBeInstanceOf(WritesTrippedError);
    });

    it("records unverified when something else the action owns changed", async () => {
      const { writer, breaker } = setup();
      const { target, record } = stockSystem();
      const sloppy: WriteTarget<Delta, Level> = {
        ...target,
        write: async (input) => {
          record.title = "Overwritten";
          return target.write(input);
        },
      };
      await expect(writer.run(sloppy, proposal())).rejects.toBeInstanceOf(WriteUnverifiedError);
      expect(await breaker.tripped("demo-org", "demo")).not.toBeNull();
    });

    it("records unverified when the record cannot be read back", async () => {
      const { writer, audit, breaker } = setup();
      const { target } = stockSystem();
      let reads = 0;
      const blind: WriteTarget<Delta, Level> = { ...target, read: async () => (reads++ === 0 ? target.read() : Promise.reject(new Error("timeout"))) };
      await expect(writer.run(blind, proposal())).rejects.toThrow(/could not be verified \(could not read the record back: timeout\)/);
      expect(audit.entries[0]).toMatchObject({ outcome: "unverified", before: { available: 5 } });
      expect(audit.entries[0]!.after).toBeUndefined();
      expect(await breaker.tripped("demo-org", "demo")).not.toBeNull();
    });

    it("stays off until a named person clears it", async () => {
      const { writer, breaker } = setup();
      const { target, calls } = stockSystem();
      await breaker.trip("demo-org", "demo", { reason: "earlier mismatch", at: `${DAY}T09:00:00Z` });
      await expect(writer.run(target, proposal())).rejects.toThrow(/until a person clears the breaker \(tripped 2026-10-22T09:00:00Z: earlier mismatch\)/);
      expect(calls).toEqual({ writes: 0, reads: 0 });
      await expect(writer.clearBreaker("demo", " ")).rejects.toThrow(/needs a named person/);
      await writer.clearBreaker("demo", "user:owner");
      expect(breaker.clearances).toEqual([{ organizationId: "demo-org", integration: "demo", clearedBy: "user:owner" }]);
      await expect(writer.run(target, proposal())).resolves.toMatchObject({ outcome: "verified" });
    });

    it("trips only the integration that misbehaved, on that instance", async () => {
      const { writer, breaker } = setup();
      await breaker.trip("other-org", "demo", { reason: "x", at: DAY });
      await breaker.trip("demo-org", "elsewhere", { reason: "x", at: DAY });
      const { target } = stockSystem();
      await expect(writer.run(target, proposal())).resolves.toMatchObject({ outcome: "verified" });
    });
  });

  describe("undo", () => {
    it("builds an inverse update that needs fresh approval and passes every check", async () => {
      const { writer } = setup();
      const { target, record } = stockSystem();
      const original = proposal();
      const result = await writer.run(target, original);
      const undo = undoProposal(target, original, result, "user:owner");
      expect(undo).toEqual({
        action: adjust,
        key: "p-1:undo",
        requestedBy: "user:owner",
        evidence: "undo:p-1",
        input: { delta: -2 },
        expected: { sku: "SKU-1", title: "Demo ring", available: 7 },
      });
      await expect(writer.run(target, undo)).rejects.toBeInstanceOf(WriteApprovalRequiredError);
      await writer.run(target, { ...undo, approvedBy: "user:owner" });
      expect(record.available).toBe(5);
    });

    it("rejects to undo anything but a verified update with an inverse", async () => {
      const { target } = stockSystem();
      const verified = { key: "p-1", outcome: "verified" as const, replayed: false, before: proposal().expected, after: proposal().expected };
      expect(() => undoProposal(target, proposal({ action: { ...adjust, kind: "append" } }), verified, "u")).toThrow(/created id/);
      expect(() => undoProposal(target, proposal({ action: { ...adjust, kind: undefined as unknown as WriteKind } }), verified, "u")).not.toThrow();
      expect(() => undoProposal(target, proposal(), { ...verified, outcome: "unverified" }, "u")).toThrow(/only a verified write/);
      expect(() => undoProposal(target, proposal(), { key: "p-1", outcome: "verified", replayed: false, before: verified.before }, "u")).toThrow(/only a verified write/);
      expect(() => undoProposal(target, proposal(), { key: "p-1", outcome: "verified", replayed: false, after: verified.after }, "u")).toThrow(/only a verified write/);
      const { invert: _, ...noInverse } = target;
      expect(() => undoProposal(noInverse, proposal(), verified, "u")).toThrow(/has no inverse/);
    });
  });

  it("records the id an append created", async () => {
    const notes: string[] = [];
    const append: WriteAction = { integration: "demo", name: "add_note", description: "Add a note", kind: "append" };
    const target: WriteTarget<{ note: string }, { notes: string[] }> = {
      schema: z.object({ note: z.string().min(1).max(500) }),
      fields: ["notes"],
      read: async () => ({ notes: [...notes] }),
      write: async ({ note }) => {
        notes.push(note);
        return { id: `note-${notes.length}` };
      },
      verify: (after, input, before) => sameState(after.notes, [...before.notes, input.note]),
    };
    const { writer, audit } = setup();
    const result = await writer.run(target, { action: append, key: "n-1", requestedBy: "user:owner", evidence: "recommendation:r2", input: { note: "Called about resize" }, expected: { notes: [] }, approvedBy: "user:owner" });
    expect(result.createdId).toBe("note-1");
    expect(audit.entries[0]).toMatchObject({ kind: "append", createdId: "note-1", before: { notes: [] }, after: { notes: ["Called about resize"] } });
    await expect(writer.run(target, { action: append, key: "n-2", requestedBy: "user:owner", evidence: "e", input: { note: "x".repeat(501) }, expected: { notes: [] }, approvedBy: "user:owner" })).rejects.toBeInstanceOf(WriteShapeError);
  });

  it("does not trust an adapter that returns nothing from write", async () => {
    const { writer, audit } = setup();
    const { target } = stockSystem();
    const odd: WriteTarget<Delta, Level> = { ...target, write: async (input) => (await target.write(input), undefined as unknown as { id?: string }) };
    await expect(writer.run(odd, proposal())).resolves.toMatchObject({ outcome: "verified" });
    expect(audit.entries[0]!.createdId).toBeUndefined();
  });
});

describe("state comparison", () => {
  it("compares snapshots structurally", () => {
    expect(sameState({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(sameState({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameState({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameState({ a: 1, c: undefined }, { a: 1, b: undefined })).toBe(false);
    expect(sameState([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameState([1, 2], [1, 2, 3])).toBe(false);
    expect(sameState(new Date(5), new Date(5))).toBe(true);
    expect(sameState(new Date(5), new Date(6))).toBe(false);
    expect(sameState(new Date(5), 5)).toBe(false);
    expect(sameState({}, new Date(5))).toBe(false);
    expect(sameState(null, {})).toBe(false);
    expect(sameState({}, null)).toBe(false);
    expect(sameState("1", 1)).toBe(false);
    expect(sameState(Number.NaN, Number.NaN)).toBe(true);
  });

  it("gives up on very deep structures rather than recursing forever", () => {
    const deep = (n: number): unknown => (n === 0 ? {} : { d: deep(n - 1) });
    expect(sameState(deep(10), deep(10))).toBe(true);
    expect(sameState(deep(40), deep(40))).toBe(false);
  });
});

describe("in-memory stores", () => {
  it("never counts below zero", async () => {
    const caps = new InMemoryWriteCapStore();
    await caps.giveBack("o", "a", DAY);
    expect(caps.used("o", "a", DAY)).toBe(0);
    expect(await caps.take("o", "a", DAY, 1)).toBe(true);
    expect(await caps.take("o", "a", DAY, 1)).toBe(false);
    expect(await caps.take("o", "b", DAY, 1)).toBe(true);
  });
});
