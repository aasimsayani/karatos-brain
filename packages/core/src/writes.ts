import type { ZodType } from "zod";

/**
 * Writing back to outside systems. Every connector starts read-only: it may
 * declare the write actions it could perform, but each one runs through a
 * WriteGate that refuses it unless the instance has turned writes on for that
 * integration and action. Every attempt, allowed or not, is audited.
 *
 * SafeWriter adds the careful checks on top: shape, approval, a fresh
 * precondition, a daily cap, idempotency and a postcondition with a circuit
 * breaker. See docs/architecture/write-back.md.
 */

/**
 * What a write does, safest first. A draft creates something a person sends
 * or publishes; an append adds a note, tag, entry or new record; an update
 * changes fields of one record. There is no delete: KaratOS never deletes
 * anything in a client's system.
 */
export type WriteKind = "draft" | "append" | "update";
export const WRITE_KINDS: readonly WriteKind[] = ["draft", "append", "update"];

/** "each": a named person approves every write. "none": only allowed for drafts. */
export type WriteApproval = "each" | "none";

/** The most writes one action may make on one instance in a UTC day. */
export const DEFAULT_DAILY_WRITE_CAP = 25;

export interface WriteAction {
  /** Integration id from the catalog, e.g. "shopify". */
  integration: string;
  /** Action name within the integration, e.g. "adjust_inventory". */
  name: string;
  description: string;
  /** Defaults to "update", the strictest. */
  kind?: WriteKind;
  /** Defaults to "each". "none" is rejected unless the kind is "draft". */
  approval?: WriteApproval;
  /** A lower daily cap than DEFAULT_DAILY_WRITE_CAP. Higher values are rejected. */
  dailyCap?: number;
}

/**
 * Which writes an instance allows, from ENABLED_WRITES entries such as
 * "shopify:adjust_inventory" or "shopify:*". Empty means read-only.
 */
export interface WritePolicy {
  allows(action: WriteAction): boolean;
}

const ENTRY = /^([a-z0-9_]+):([a-z0-9_]+|\*)$/;

/** Returns the entries that are not of the form integration:action or integration:*. */
export function invalidWriteEntries(entries: string[]): string[] {
  return entries.filter((entry) => !ENTRY.test(entry));
}

export function writePolicy(entries: string[]): WritePolicy {
  const invalid = invalidWriteEntries(entries);
  if (invalid.length > 0) throw new Error(`invalid write entries: ${invalid.join(", ")}`);
  const allowed = new Set(entries);
  return {
    allows: (action) => allowed.has(`${action.integration}:${action.name}`) || allowed.has(`${action.integration}:*`),
  };
}

export const READ_ONLY: WritePolicy = { allows: () => false };

export type WriteOutcome = "refused" | "stale" | "capped" | "performed" | "verified" | "unverified" | "failed";

export interface WriteAuditEntry {
  organizationId: string;
  integration: string;
  action: string;
  /** Who or what asked for the write, e.g. a user id or "recommendation:<id>". */
  requestedBy: string;
  outcome: WriteOutcome;
  at: string;
  error?: string;
  /** The proposal's idempotency key. */
  proposalKey?: string;
  kind?: WriteKind;
  /** The named person who approved the write. */
  approvedBy?: string;
  /** What the write is based on, e.g. the recommendation id. */
  evidence?: string;
  /** Values of only the fields the action touches, before the write. */
  before?: Record<string, unknown>;
  /** Values of only the fields the action touches, read back after the write. */
  after?: Record<string, unknown>;
  /** The id of the record or draft the write created, so a person can find it. */
  createdId?: string;
}

export interface WriteAuditLog {
  recordWrite(entry: WriteAuditEntry): Promise<void>;
}

export class WritesDisabledError extends Error {
  constructor(readonly action: WriteAction) {
    super(`writes to ${action.integration} (${action.name}) are turned off for this instance`);
    this.name = "WritesDisabledError";
  }
}

export interface WriteGateOptions {
  organizationId: string;
  policy: WritePolicy;
  audit: WriteAuditLog;
  now?: () => Date;
}

export class WriteGate {
  private readonly now: () => Date;

  constructor(private readonly options: WriteGateOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get organizationId(): string {
    return this.options.organizationId;
  }

  /** Whether the instance's policy allows the action. */
  allows(action: WriteAction): boolean {
    return this.options.policy.allows(action);
  }

  /** The gate's clock. */
  clock(): Date {
    return this.now();
  }

  /** Records an audit entry for this gate's organization, stamped with the gate's clock. */
  async record(entry: Omit<WriteAuditEntry, "organizationId" | "at">): Promise<void> {
    await this.options.audit.recordWrite({ organizationId: this.options.organizationId, ...entry, at: this.now().toISOString() });
  }

  /** Runs perform only if the policy allows the action; audits every attempt. */
  async run<T>(action: WriteAction, requestedBy: string, perform: () => Promise<T>): Promise<T> {
    const base = {
      organizationId: this.options.organizationId,
      integration: action.integration,
      action: action.name,
      requestedBy,
    };
    if (!this.options.policy.allows(action)) {
      await this.options.audit.recordWrite({ ...base, outcome: "refused", at: this.now().toISOString() });
      throw new WritesDisabledError(action);
    }
    try {
      const result = await perform();
      await this.options.audit.recordWrite({ ...base, outcome: "performed", at: this.now().toISOString() });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.audit.recordWrite({ ...base, outcome: "failed", at: this.now().toISOString(), error: message });
      throw error;
    }
  }
}

/** Keeps audit entries in memory, for tests and local use. */
export class InMemoryWriteAuditLog implements WriteAuditLog {
  readonly entries: WriteAuditEntry[] = [];

  async recordWrite(entry: WriteAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Careful write-back: SafeWriter runs every check in docs/architecture/write-back.md.
// ---------------------------------------------------------------------------

/** Reasons an action's declaration is unsafe. Empty means it may run. */
export function writeActionProblems(action: WriteAction): string[] {
  const problems: string[] = [];
  const kind = action.kind ?? "update";
  if (!WRITE_KINDS.includes(kind)) problems.push(`unknown write kind "${String(kind).slice(0, 40)}"; KaratOS only drafts, appends and updates`);
  if (action.approval !== undefined && action.approval !== "each" && action.approval !== "none") problems.push("approval must be each or none");
  if (action.approval === "none" && kind !== "draft") problems.push('approval "none" is only allowed for drafts');
  const cap = action.dailyCap;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 1 && cap <= DEFAULT_DAILY_WRITE_CAP)) {
    problems.push(`dailyCap must be a whole number from 1 to ${DEFAULT_DAILY_WRITE_CAP}`);
  }
  return problems;
}

/**
 * The approval a write needs. Only a draft can go without one, and an
 * instance setting can raise an action's level but never lower it.
 */
export function requiredApproval(action: WriteAction, instance?: WriteApproval): WriteApproval {
  const declared = (action.kind ?? "update") === "draft" ? (action.approval ?? "each") : "each";
  return declared === "each" || instance === "each" ? "each" : "none";
}

/** The most times the action may write on one instance in a UTC day. */
export function dailyWriteCap(action: WriteAction): number {
  return action.dailyCap ?? DEFAULT_DAILY_WRITE_CAP;
}

/** Structural equality for record snapshots: plain objects, arrays, dates and primitives. */
export function sameState(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 32) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameState(left[key], right[key], depth + 1));
}

/** A write someone proposes. Nothing is sent until every check passes. */
export interface WriteProposal<I, S> {
  action: WriteAction;
  /** Idempotency key: a replay with the same key returns the earlier result and sends nothing. */
  key: string;
  /** Who or what asked, e.g. "recommendation:<id>" or a user id. */
  requestedBy: string;
  /** What the write is based on, e.g. the recommendation id. */
  evidence: string;
  input: I;
  /** The record as the proposal saw it. Any difference at write time rejects the write as stale. */
  expected: S;
  /** The named person who approved this write. */
  approvedBy?: string;
}

/** A connector's adapter for one write action against one record. */
export interface WriteTarget<I, S extends object> {
  /** The action's input, with its limits (e.g. a maximum delta, percent or length). */
  schema: ZodType<I>;
  /** The fields of the record the action touches. Only these are audited. */
  fields: readonly (keyof S & string)[];
  /** Reads the record (the fields the action depends on) from the client's system. */
  read(): Promise<S>;
  /** Sends the write. Returns the id of anything it created. */
  write(input: I): Promise<{ id?: string }>;
  /** True only if the change landed exactly and nothing else the action owns changed. */
  verify(after: S, input: I, before: S): boolean;
  /** For an update: the input that puts the touched fields back as they were. */
  invert?(before: S, input: I): I;
}

export interface SafeWriteResult<S> {
  key: string;
  outcome: "verified" | "unverified" | "failed";
  /** True when this call was a replay and nothing was sent. */
  replayed: boolean;
  createdId?: string;
  before?: S;
  after?: S;
  error?: string;
}

/** Per action, per instance, per UTC day write allowance. */
export interface WriteCapStore {
  /** Takes one write from the day's allowance; false when none is left. */
  take(organizationId: string, actionId: string, day: string, cap: number): Promise<boolean>;
  /** Gives back a write taken for an attempt that was never sent. */
  giveBack(organizationId: string, actionId: string, day: string): Promise<void>;
}

export type WriteClaim = { status: "new" } | { status: "pending" } | { status: "done"; result: SafeWriteResult<unknown> };

export interface WriteIdempotencyStore {
  /** Reserves the key, or reports it is in flight or already done. */
  claim(organizationId: string, key: string): Promise<WriteClaim>;
  complete(organizationId: string, key: string, result: SafeWriteResult<unknown>): Promise<void>;
  /** Frees a reserved key whose attempt was rejected before anything was sent. */
  release(organizationId: string, key: string): Promise<void>;
}

export interface WriteBreakerTrip {
  reason: string;
  at: string;
}

/** Turns off every write for an integration on an instance until a person clears it. */
export interface WriteBreaker {
  tripped(organizationId: string, integration: string): Promise<WriteBreakerTrip | null>;
  trip(organizationId: string, integration: string, trip: WriteBreakerTrip): Promise<void>;
  clear(organizationId: string, integration: string, clearedBy: string): Promise<void>;
}

const storeKey = (...parts: string[]) => JSON.stringify(parts);

export class InMemoryWriteCapStore implements WriteCapStore {
  private readonly counts = new Map<string, number>();

  async take(organizationId: string, actionId: string, day: string, cap: number): Promise<boolean> {
    const key = storeKey(organizationId, actionId, day);
    const used = this.counts.get(key) ?? 0;
    if (used >= cap) return false;
    this.counts.set(key, used + 1);
    return true;
  }

  async giveBack(organizationId: string, actionId: string, day: string): Promise<void> {
    const key = storeKey(organizationId, actionId, day);
    this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 0) - 1));
  }

  used(organizationId: string, actionId: string, day: string): number {
    return this.counts.get(storeKey(organizationId, actionId, day)) ?? 0;
  }
}

export class InMemoryWriteIdempotencyStore implements WriteIdempotencyStore {
  private readonly claims = new Map<string, SafeWriteResult<unknown> | "pending">();

  async claim(organizationId: string, key: string): Promise<WriteClaim> {
    const id = storeKey(organizationId, key);
    const existing = this.claims.get(id);
    if (existing === "pending") return { status: "pending" };
    if (existing !== undefined) return { status: "done", result: existing };
    this.claims.set(id, "pending");
    return { status: "new" };
  }

  async complete(organizationId: string, key: string, result: SafeWriteResult<unknown>): Promise<void> {
    this.claims.set(storeKey(organizationId, key), result);
  }

  async release(organizationId: string, key: string): Promise<void> {
    this.claims.delete(storeKey(organizationId, key));
  }
}

export class InMemoryWriteBreaker implements WriteBreaker {
  private readonly trips = new Map<string, WriteBreakerTrip>();
  readonly clearances: { organizationId: string; integration: string; clearedBy: string }[] = [];

  async tripped(organizationId: string, integration: string): Promise<WriteBreakerTrip | null> {
    return this.trips.get(storeKey(organizationId, integration)) ?? null;
  }

  async trip(organizationId: string, integration: string, trip: WriteBreakerTrip): Promise<void> {
    this.trips.set(storeKey(organizationId, integration), trip);
  }

  async clear(organizationId: string, integration: string, clearedBy: string): Promise<void> {
    this.trips.delete(storeKey(organizationId, integration));
    this.clearances.push({ organizationId, integration, clearedBy });
  }
}

export class WriteActionInvalidError extends Error {
  constructor(
    readonly action: WriteAction,
    readonly problems: string[],
  ) {
    super(`write ${action.integration} (${action.name}) is declared unsafely: ${problems.join("; ")}`);
    this.name = "WriteActionInvalidError";
  }
}

export class WritesTrippedError extends Error {
  constructor(
    readonly action: WriteAction,
    readonly trip: WriteBreakerTrip,
  ) {
    super(`writes to ${action.integration} are off on this instance until a person clears the breaker (tripped ${trip.at}: ${trip.reason})`);
    this.name = "WritesTrippedError";
  }
}

export class WriteShapeError extends Error {
  constructor(
    readonly action: WriteAction,
    readonly issues: string[],
  ) {
    super(`write ${action.integration} (${action.name}) is mis-shaped: ${issues.join("; ")}`);
    this.name = "WriteShapeError";
  }
}

export class WriteApprovalRequiredError extends Error {
  constructor(readonly action: WriteAction) {
    super(`write ${action.integration} (${action.name}) needs a named person to approve it`);
    this.name = "WriteApprovalRequiredError";
  }
}

export class WriteInFlightError extends Error {
  constructor(
    readonly action: WriteAction,
    readonly key: string,
  ) {
    super(`write ${action.integration} (${action.name}) with this key is already running`);
    this.name = "WriteInFlightError";
  }
}

export class WriteCapReachedError extends Error {
  constructor(
    readonly action: WriteAction,
    readonly cap: number,
  ) {
    super(`write ${action.integration} (${action.name}) reached its cap of ${cap} today`);
    this.name = "WriteCapReachedError";
  }
}

export class WriteStaleError extends Error {
  constructor(readonly action: WriteAction) {
    super(`write ${action.integration} (${action.name}) is stale: the record changed since the proposal saw it, so nothing was sent`);
    this.name = "WriteStaleError";
  }
}

export class WriteUnverifiedError extends Error {
  constructor(
    readonly action: WriteAction,
    readonly reason: string,
  ) {
    super(`write ${action.integration} (${action.name}) could not be verified (${reason}); writes to ${action.integration} are now off until a person clears them`);
    this.name = "WriteUnverifiedError";
  }
}

export interface SafeWriterOptions {
  /** The instance's policy and audit log. */
  gate: WriteGate;
  caps: WriteCapStore;
  idempotency: WriteIdempotencyStore;
  breaker: WriteBreaker;
  /** Instance approval settings by "integration:action" or "integration:*". They can only raise an action's level. */
  approvals?: Record<string, WriteApproval>;
}

const TEXT_LIMIT = 200;
const clip = (value: unknown): string => (typeof value === "string" ? value.slice(0, TEXT_LIMIT) : "");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function touched<S extends object>(state: S, fields: readonly (keyof S & string)[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, state[field]]));
}

/**
 * Runs a write proposal through every check, in order: declaration, policy,
 * breaker, shape, approval, idempotency, daily cap, fresh precondition, then
 * the write and its postcondition. Every attempt is audited once.
 */
export class SafeWriter {
  constructor(private readonly options: SafeWriterOptions) {}

  /** The approval this instance requires for the action. */
  approvalFor(action: WriteAction): WriteApproval {
    const settings = this.options.approvals ?? {};
    const pick = (id: string) => (Object.hasOwn(settings, id) ? settings[id] : undefined);
    return requiredApproval(action, pick(`${action.integration}:${action.name}`) ?? pick(`${action.integration}:*`));
  }

  /** Turns an integration's writes back on after a person has checked the client's system. */
  async clearBreaker(integration: string, clearedBy: string): Promise<void> {
    if (!isText(clearedBy, TEXT_LIMIT)) throw new Error("clearing the write breaker needs a named person");
    await this.options.breaker.clear(this.options.gate.organizationId, integration, clearedBy);
  }

  async run<I, S extends object>(target: WriteTarget<I, S>, proposal: WriteProposal<I, S>): Promise<SafeWriteResult<S>> {
    const { gate, caps, idempotency, breaker } = this.options;
    const { action } = proposal;
    const org = gate.organizationId;
    const actionId = `${action.integration}:${action.name}`;
    const base = {
      integration: action.integration,
      action: action.name,
      requestedBy: clip(proposal.requestedBy),
      proposalKey: clip(proposal.key),
      kind: action.kind ?? "update",
      evidence: clip(proposal.evidence),
      ...(isText(proposal.approvedBy, TEXT_LIMIT) ? { approvedBy: proposal.approvedBy } : {}),
    };
    const stopped = (error: string) => gate.record({ ...base, outcome: "refused", error });
    const reject = async (error: Error): Promise<never> => {
      await stopped(error.message);
      throw error;
    };

    const problems = writeActionProblems(action);
    if (problems.length > 0) return reject(new WriteActionInvalidError(action, problems));
    if (!gate.allows(action)) return reject(new WritesDisabledError(action));
    const trip = await breaker.tripped(org, action.integration);
    if (trip) return reject(new WritesTrippedError(action, trip));

    const issues: string[] = [];
    if (!isText(proposal.key, 256)) issues.push("key: a non-empty string of at most 256 characters");
    if (!isText(proposal.requestedBy, TEXT_LIMIT)) issues.push(`requestedBy: a non-empty string of at most ${TEXT_LIMIT} characters`);
    if (!isText(proposal.evidence, TEXT_LIMIT)) issues.push(`evidence: a non-empty string of at most ${TEXT_LIMIT} characters`);
    const parsed = target.schema.safeParse(proposal.input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 10)) issues.push(`input${issue.path.map((p) => `.${String(p)}`).join("")}: ${issue.message}`);
    }
    if (issues.length > 0 || !parsed.success) return reject(new WriteShapeError(action, issues));
    const input = parsed.data;

    if (this.approvalFor(action) === "each" && !isText(proposal.approvedBy, TEXT_LIMIT)) {
      return reject(new WriteApprovalRequiredError(action));
    }

    const claimKey = storeKey(actionId, proposal.key);
    const claim = await idempotency.claim(org, claimKey);
    if (claim.status === "done") {
      await stopped(`replayed key: returned the earlier ${claim.result.outcome} result, nothing sent`);
      return { ...(claim.result as SafeWriteResult<S>), replayed: true };
    }
    if (claim.status === "pending") return reject(new WriteInFlightError(action, proposal.key));

    const day = gate.clock().toISOString().slice(0, 10);
    const cap = dailyWriteCap(action);
    if (!(await caps.take(org, actionId, day, cap))) {
      await idempotency.release(org, claimKey);
      const error = new WriteCapReachedError(action, cap);
      await gate.record({ ...base, outcome: "capped", error: error.message });
      throw error;
    }
    const unsent = async () => {
      await caps.giveBack(org, actionId, day);
      await idempotency.release(org, claimKey);
    };

    let before: S;
    try {
      before = await target.read();
    } catch (error) {
      await unsent();
      return reject(new Error(`could not re-read the record before writing: ${message(error)}`));
    }
    if (!sameState(before, proposal.expected)) {
      await unsent();
      const error = new WriteStaleError(action);
      await gate.record({ ...base, outcome: "stale", error: error.message, before: touched(before, target.fields) });
      throw error;
    }

    let created: { id?: string };
    try {
      created = await target.write(input);
    } catch (error) {
      const result: SafeWriteResult<S> = { key: proposal.key, outcome: "failed", replayed: false, before, error: message(error) };
      await idempotency.complete(org, claimKey, result);
      await gate.record({ ...base, outcome: "failed", error: result.error!, before: touched(before, target.fields) });
      throw error;
    }
    const createdId = typeof created?.id === "string" ? { createdId: created.id.slice(0, TEXT_LIMIT) } : {};

    let after: S | undefined;
    let problem: string | undefined;
    try {
      after = await target.read();
      if (target.verify(after, input, before) !== true) problem = "the record read back does not match the write";
    } catch (error) {
      problem = `could not read the record back: ${message(error)}`;
    }
    const states = { before: touched(before, target.fields), ...(after === undefined ? {} : { after: touched(after, target.fields) }) };
    if (problem !== undefined) {
      await breaker.trip(org, action.integration, { reason: `${actionId} ${proposal.key.slice(0, TEXT_LIMIT)}: ${problem}`, at: gate.clock().toISOString() });
      const result: SafeWriteResult<S> = { key: proposal.key, outcome: "unverified", replayed: false, before, ...(after === undefined ? {} : { after }), ...createdId, error: problem };
      await idempotency.complete(org, claimKey, result);
      await gate.record({ ...base, outcome: "unverified", error: problem, ...states, ...createdId });
      throw new WriteUnverifiedError(action, problem);
    }
    const result: SafeWriteResult<S> = { key: proposal.key, outcome: "verified", replayed: false, before, after: after!, ...createdId };
    await idempotency.complete(org, claimKey, result);
    await gate.record({ ...base, outcome: "verified", ...states, ...createdId });
    return result;
  }
}

/**
 * The proposal that undoes a verified update: it puts the touched fields
 * back and runs through every check again, with a fresh approval. Appends
 * and drafts are undone by a person, using the created id in the audit.
 */
export function undoProposal<I, S extends object>(
  target: WriteTarget<I, S>,
  proposal: WriteProposal<I, S>,
  result: SafeWriteResult<S>,
  requestedBy: string,
): WriteProposal<I, S> {
  if ((proposal.action.kind ?? "update") !== "update") throw new Error("only an update is undone by a proposal; remove a draft or append by its created id");
  if (result.outcome !== "verified" || result.before === undefined || result.after === undefined) throw new Error("only a verified write can be undone");
  if (!target.invert) throw new Error(`write ${proposal.action.name} has no inverse`);
  return {
    action: proposal.action,
    key: `${proposal.key}:undo`,
    requestedBy,
    evidence: `undo:${proposal.key}`,
    input: target.invert(result.before, proposal.input),
    expected: result.after,
  };
}
