# Careful write-back

KaratOS reads a business's systems to find what needs doing. Sometimes the useful next step is to change something in one of those systems: draft a purchase order, tag a customer, correct a stock count. Reading a wrong number costs an insight. Writing a wrong number changes the client's books, stock or customer records, and one bad change can cost their trust. So a write has to be twice as sure as a read.

This page explains how a write is checked, first for an owner and then for a developer.

## For an owner

**Nothing writes unless you turn it on.** Every connector is read-only by default. You turn writes on per instance, per integration and per action (`ENABLED_WRITES`, e.g. `shopify:tag_customer`). Today no connector has a write turned on.

**KaratOS never deletes anything in your systems.** A write is one of three kinds, safest first:

| Kind | What it does | Example | How it is undone |
| --- | --- | --- | --- |
| Draft | Creates something a person sends or publishes | A draft email, purchase order or listing | Delete the draft; its id is in the audit |
| Append | Adds something new | A note, a tag, a timeline entry, a new record | Remove it; its id is in the audit |
| Update | Changes fields of one record | A stock count, a price | KaratOS proposes the reverse change, which goes through every check again |

**A named person approves each write.** Only a draft may skip approval, and only if its action says so, because a draft changes nothing until someone sends it. Your instance settings can make approval stricter but never looser.

**Before every write, KaratOS looks again.** It re-reads the record right before writing. If anything changed since the suggestion was made (a sale, someone else's edit), nothing is sent.

**After every write, KaratOS checks it landed.** It reads the record back. If the change is not exactly what was asked, or something else changed, every write to that system stops until a person has looked and turned writes back on.

**There are limits.** Each action has a daily cap (25 at most, lower if the action says so), and each action limits how big one change can be, such as a maximum stock adjustment or note length. A request that is sent twice is only carried out once.

**Everything is recorded.** Every attempt, including the ones stopped by a check, is kept with who asked, who approved, what it was based on, the values of the changed fields before and after, and what happened. Only the fields the action touches are recorded, never the whole record.

**Your systems stay the source of truth.** A write lands in your system, not in a copy inside KaratOS.

## For a developer

`SafeWriter` in `packages/core/src/writes.ts` runs a `WriteProposal` against a `WriteTarget`, the connector's adapter for one action on one record:

```ts
const target: WriteTarget<Input, State> = {
  schema,        // zod schema for the input, including the action's limits
  fields,        // the fields of State the action touches; only these are audited
  read,          // reads the record from the client's system
  write,         // sends the write, returns { id } of anything created
  verify,        // (after, input, before) => true only if exactly the change landed
  invert,        // optional, for updates: the input that puts the fields back
};
const proposal = { action, key, requestedBy, evidence, input, expected, approvedBy };
await writer.run(target, proposal);
```

`WriteAction` gains three optional fields: `kind` (`draft`, `append` or `update`; default `update`, the strictest), `approval` (`each` by default; `none` only for drafts) and `dailyCap` (1 to 25). Existing actions that declare none of these are treated as updates that each need approval, with the default cap.

### The checks, in order

Each stopped attempt is audited once and nothing is sent. The error named is what `run` throws. Checks 1 to 6 are audited with the outcome `refused`.

| # | Check | Error | Audit outcome |
| --- | --- | --- | --- |
| 1 | The action's declaration is safe: a known kind (no delete), `approval: "none"` only on a draft, a cap from 1 to 25 | `WriteActionInvalidError` | as above |
| 2 | Policy: the instance allows `integration:action` | `WritesDisabledError` | as above |
| 3 | Breaker: writes to this integration on this instance are not switched off | `WritesTrippedError` | as above |
| 4 | Shape: the key, requester and evidence are present and short, and the input passes the target's schema | `WriteShapeError` | as above |
| 5 | Approval: a named person approved, unless the action is a draft that needs none (instance settings only raise this) | `WriteApprovalRequiredError` | as above |
| 6 | Idempotency: a key already used returns the earlier result (`replayed: true`); a key still running is rejected | `WriteInFlightError` | as above |
| 7 | Daily cap: one write is taken from the action's allowance for the UTC day | `WriteCapReachedError` | `capped` |
| 8 | Fresh precondition: the record is re-read and must equal `expected` exactly | `WriteStaleError` | `stale` |
| 9 | The write itself; if it throws, the key keeps the failure so a replay can't send it twice | the vendor's error | `failed` |
| 10 | Postcondition: the record is read back and `verify` must return `true`; otherwise the breaker trips for the whole integration | `WriteUnverifiedError` | `unverified` |

A write that passes every check is audited as `verified`. A rejected or stale attempt gives back its cap and frees its key, so a corrected proposal can run.

Two differences from the first design sketch: the idempotency check runs before the cap and the precondition, so a replay returns its earlier result instead of looking stale (the record changed because the first write landed); and the cap is taken before the re-read, so the re-read is the last step before sending.

### Undo

`undoProposal(target, proposal, result, requestedBy)` builds the reverse of a verified update from the stored before-state. It has a new key, no approval and the after-state as `expected`, so it goes through every check, including a fresh approval. Drafts and appends are undone by a person using the created id in the audit, because KaratOS does not delete.

### Stores

The daily caps (`WriteCapStore`), idempotency keys (`WriteIdempotencyStore`) and breaker (`WriteBreaker`) are small interfaces with in-memory implementations. Postgres versions, and `write_audit` columns for the new outcomes and fields, come before any connector turns a write on. Until then the Postgres audit table keeps the original fields and outcomes.

### Testing a write

`assertWriteSafety(target, proposal)` in the connector test kit runs a target through `SafeWriter` and fails unless it rejects a turned-off, mis-shaped, unapproved, stale and over-cap write without sending anything, catches a write that silently does nothing as unverified and trips the breaker, and sends a replayed proposal only once. It sends the proposal for real once, so point it at a mock or sandbox.

Turning on a real write later needs: the vendor's write scope (the owner's decision for each client), a sandbox run, and the action's own tests through `assertWriteSafety`.

See also the [security model](../security.md) and the [architecture overview](overview.md).
