import {
  InMemoryWriteAuditLog,
  InMemoryWriteBreaker,
  InMemoryWriteCapStore,
  InMemoryWriteIdempotencyStore,
  READ_ONLY,
  SafeWriter,
  WriteApprovalRequiredError,
  WriteCapReachedError,
  WriteGate,
  WriteShapeError,
  WriteStaleError,
  WriteUnverifiedError,
  WritesDisabledError,
  WritesTrippedError,
  dailyWriteCap,
  requiredApproval,
  sameState,
  writePolicy,
  type Connector,
  type SafeWriteResult,
  type WriteAuditEntry,
  type WritePolicy,
  type WriteProposal,
  type WriteTarget,
} from "@karatos/core";
import { TEST_ORG } from "./harness.js";

/**
 * Runs every write action a connector declares through a read-only
 * WriteGate and checks each one is refused, audited and never performed.
 * Returns the audit entries. Throws if any write got through.
 */
export async function assertWritesRefused(connector: Connector): Promise<WriteAuditEntry[]> {
  const audit = new InMemoryWriteAuditLog();
  const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
  for (const action of connector.writes ?? []) {
    if (action.integration !== connector.source) {
      throw new Error(`write ${action.name} is declared for ${action.integration}, not ${connector.source}`);
    }
    let performed = false;
    const refused = await gate
      .run(action, "connector-testkit", async () => {
        performed = true;
      })
      .then(
        () => false,
        (error: unknown) => error instanceof WritesDisabledError,
      );
    if (performed || !refused) throw new Error(`write ${action.name} was not refused by a read-only gate`);
  }
  return audit.entries;
}

export class WriteSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteSafetyError";
  }
}

export interface WriteSafetyOptions {
  /** Inputs the action's schema must reject. Defaults to undefined, null and an unrelated object. */
  badInputs?: unknown[];
}

export interface WriteSafetyReport<S> {
  /** The one write that was sent, verified. */
  result: SafeWriteResult<S>;
  audit: WriteAuditEntry[];
}

const UNRELATED = { assertWriteSafety: "unrelated input" };
const STALE = { assertWriteSafety: "a record the target never returns" };

const describeOutcome = (outcome: unknown) =>
  outcome instanceof Error ? `${outcome.name}: ${outcome.message}` : outcome === null ? "the write went through" : String(outcome);

/**
 * Runs a write target through SafeWriter and checks it rejects a write that
 * is turned off, mis-shaped, unapproved, stale or over its daily cap without
 * sending anything; that a write which silently does nothing is caught as
 * unverified and trips the breaker; and that a replayed proposal sends
 * nothing. Sends the proposal for real exactly once, so point it at a mock
 * or sandbox. `proposal.expected` must match what the target reads now.
 */
export async function assertWriteSafety<I, S extends object>(
  target: WriteTarget<I, S>,
  proposal: WriteProposal<I, S>,
  options: WriteSafetyOptions = {},
): Promise<WriteSafetyReport<S>> {
  const { action } = proposal;
  const entry = `${action.integration}:${action.name}`;
  const at = new Date();
  const day = at.toISOString().slice(0, 10);
  const audit = new InMemoryWriteAuditLog();
  let sent = 0;
  const wrap = (write: (input: I) => Promise<{ id?: string }>): WriteTarget<I, S> => ({
    schema: target.schema,
    fields: target.fields,
    read: () => target.read(),
    write,
    verify: (after, input, before) => target.verify(after, input, before),
  });
  const counted = wrap((input) => {
    sent += 1;
    return target.write(input);
  });
  const writer = (overrides: { policy?: WritePolicy; caps?: InMemoryWriteCapStore; breaker?: InMemoryWriteBreaker } = {}) =>
    new SafeWriter({
      gate: new WriteGate({ organizationId: TEST_ORG, policy: overrides.policy ?? writePolicy([entry]), audit, now: () => at }),
      caps: overrides.caps ?? new InMemoryWriteCapStore(),
      idempotency: new InMemoryWriteIdempotencyStore(),
      breaker: overrides.breaker ?? new InMemoryWriteBreaker(),
    });
  const rejects = async (check: string, run: Promise<unknown>, expected: new (...args: never[]) => Error) => {
    const before = sent;
    const outcome = await run.then(
      () => null,
      (error: unknown) => error,
    );
    if (!(outcome instanceof expected)) throw new WriteSafetyError(`${entry} ${check}: expected ${expected.name}, got ${describeOutcome(outcome)}`);
    if (sent !== before) throw new WriteSafetyError(`${entry} ${check}: rejected, but the write was sent`);
  };

  const needsApproval = requiredApproval(action) === "each";
  if (needsApproval && !proposal.approvedBy?.trim()) throw new WriteSafetyError(`${entry}: the proposal needs approvedBy, since this action needs approval`);
  if (!sameState(await target.read(), proposal.expected)) throw new WriteSafetyError(`${entry}: proposal.expected must match what the target reads now`);

  await rejects("turned off", writer({ policy: READ_ONLY }).run(counted, proposal), WritesDisabledError);
  for (const input of options.badInputs ?? [undefined, null, UNRELATED]) {
    await rejects("mis-shaped input", writer().run(counted, { ...proposal, input: input as I }), WriteShapeError);
  }
  if (needsApproval) {
    const { approvedBy: _, ...unapproved } = proposal;
    await rejects("unapproved", writer().run(counted, unapproved), WriteApprovalRequiredError);
  }
  await rejects("stale", writer().run(counted, { ...proposal, expected: STALE as unknown as S }), WriteStaleError);
  const full = new InMemoryWriteCapStore();
  const cap = dailyWriteCap(action);
  for (let n = 0; n < cap; n += 1) await full.take(TEST_ORG, entry, day, cap);
  await rejects("over the daily cap", writer({ caps: full }).run(counted, proposal), WriteCapReachedError);

  // A write that silently does nothing must fail the target's own verify.
  const breaker = new InMemoryWriteBreaker();
  const tripped = writer({ breaker });
  await rejects("unverified", tripped.run(wrap(async () => ({})), proposal), WriteUnverifiedError);
  await rejects("after the breaker tripped", tripped.run(counted, { ...proposal, key: `${proposal.key}:again` }), WritesTrippedError);

  const live = writer();
  const result = await live.run(counted, proposal).catch((error: unknown) => {
    throw new WriteSafetyError(`${entry}: the proposal itself did not verify (${describeOutcome(error)})`);
  });
  const replay = await live.run(counted, proposal);
  if (sent !== 1 || !replay.replayed) throw new WriteSafetyError(`${entry}: a replayed proposal was sent again`);
  return { result, audit: audit.entries };
}
