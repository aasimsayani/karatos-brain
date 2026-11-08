import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { DOCUSIGN_PAGE_SIZE, DocusignApiError, docusignClient, docusignGuid, type DocusignClient, type DocusignClientOptions } from "./client.js";
import { docusignEnvelopeEvents, docusignTime, type DocusignBrainEvent } from "./normalize.js";
import { docusignConnectEvents } from "./webhooks.js";

/**
 * Docusign: the agreements a store sends for signature, such as consignment
 * and memo agreements, appraisals and custom orders, and who has yet to sign.
 *
 * Each pass reads the account's envelopes whose status changed since the
 * pass's start time, oldest change first, with their recipients. The
 * checkpoint keeps the latest status change read, so a resumed sync asks
 * again from there. Each incremental pass then reads every envelope still
 * out for signature, since a recipient viewing or signing doesn't always
 * change the envelope's own status. The historical import reads envelopes
 * changed in the last five years; later syncs ask from the start of the
 * last pass, less five minutes of overlap.
 *
 * Docusign asks apps to read an envelope at most once every 15 minutes, so
 * don't schedule this sync more often than that. Connect deliveries keep it
 * current in between.
 */

/** Declared so it can be gated and audited; it never runs while writes are off. */
export const DOCUSIGN_WRITES: WriteAction[] = [{ integration: "docusign", name: "send_envelope", description: "Send an agreement for signature, such as a consignment or memo agreement" }];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const DOCUSIGN_OVERLAP_MS = 5 * 60_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface DocusignCursor {
  pass: "historical" | "incremental";
  /** changed: envelopes whose status changed; open: those still out for signature; done: the pass is finished. */
  phase: "changed" | "open" | "done";
  /** The latest status change read in the changed phase, which the next page asks from. */
  from: string;
  /** Envelopes to pass over at `from` (changed phase), or the position reached (open phase). */
  skip: number;
  /** Envelopes already read whose status changed at `from`, which asking from it returns again. */
  seen: string[];
  /** Envelopes changed at or after this time are read; the open phase reads those created since it too. */
  since: string;
  /** Where the next pass starts. */
  nextFrom: string;
}

export interface DocusignOptions extends Partial<Pick<DocusignClientOptions, "fetch" | "sleep" | "rateLimitRetries" | "environment">> {
  integrationKey: string;
  userId: string;
  accountId: string;
  privateKey: string;
  /** CUSTOMER_REF_KEY: keys the references made from recipients' email addresses. */
  customerKey: string;
  /** Years of history the first import reads. Defaults to 5. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. Defaults to 24 hours. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: DocusignClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;
const MAX_SKIP = 1_000_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseDocusignCursor(raw: string | null): DocusignCursor | null {
  if (raw === null) return null;
  let c: DocusignCursor | null;
  try {
    c = JSON.parse(raw) as DocusignCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    (c.phase === "changed" || c.phase === "open" || c.phase === "done") &&
    isTime(c.from) &&
    Number.isInteger(c.skip) &&
    c.skip >= 0 &&
    c.skip <= MAX_SKIP &&
    Array.isArray(c.seen) &&
    c.seen.length <= DOCUSIGN_PAGE_SIZE &&
    c.seen.every((s) => typeof s === "string" && GUID.test(s)) &&
    isTime(c.since) &&
    isTime(c.nextFrom);
  if (!ok || !c) throw new Error("Docusign checkpoint is not in the expected shape");
  const { pass, phase, from, skip, seen, since, nextFrom } = c;
  return { pass, phase, from, skip, seen, since, nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function docusignConnector(options: DocusignOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? docusignClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 24, "incrementalLookbackHours");

  function start(mode: "historical" | "incremental", saved: DocusignCursor | null, at: Date): DocusignCursor {
    let since: string;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = from.toISOString();
    } else {
      since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    }
    return { pass: mode, phase: "changed", from: since, skip: 0, seen: [], since, nextFrom: new Date(at.getTime() - DOCUSIGN_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseDocusignCursor(context.cursor);
    const at = now();
    if (mode === "historical" && saved?.pass === "historical" && saved.phase === "done") return;
    let c = saved?.pass === mode && saved.phase !== "done" ? saved : start(mode, saved, at);
    const ctx = { receivedAt: at.toISOString(), customerKey };
    const cursor = () => JSON.stringify(c);
    const events = (data: Record<string, unknown>[]): DocusignBrainEvent[] => data.flatMap((e) => docusignEnvelopeEvents(e, ctx));

    while (c.phase === "changed") {
      const page = await client.envelopes({ from: c.from, orderBy: "status_changed", start: c.skip });
      const changed = page.data.map((e) => ({ id: docusignGuid(e.envelopeId), at: docusignTime(e.statusChangedDateTime) }));
      const latest = changed.map((e) => e.at).filter((t): t is string => t !== undefined).reduce((a, b) => (b > a ? b : a), c.from);
      // Envelopes read on the last page at the time this one asks from come back again; they aren't sent twice.
      const fresh = page.data.filter((_, i) => !(changed[i]!.at === c.from && c.seen.includes(changed[i]!.id ?? "")));
      if (page.data.length === 0 || c.skip + page.data.length >= page.total) {
        c = { ...c, phase: mode === "incremental" ? "open" : "done", from: latest, skip: 0, seen: [] };
      } else if (latest > c.from) {
        // Asked again from the latest change read, so an envelope that changes mid-pass is never passed over.
        const seen = changed.filter((e) => e.at === latest && e.id !== undefined).map((e) => e.id!);
        c = { ...c, from: latest, skip: 0, seen };
      } else {
        // A whole page changed at one time: page on past it.
        if (c.skip + page.data.length > MAX_SKIP) throw new DocusignApiError(`Docusign has more than ${MAX_SKIP} envelopes whose status changed at ${c.from}`, 0);
        c = { ...c, skip: c.skip + page.data.length };
      }
      yield { events: events(fresh), cursor: cursor() };
    }

    while (c.phase === "open") {
      const historyStart = new Date(at);
      historyStart.setUTCFullYear(historyStart.getUTCFullYear() - historyYears);
      const page = await client.envelopes({ from: historyStart.toISOString(), status: ["sent", "delivered"], orderBy: "created", start: c.skip });
      const skip = c.skip + page.data.length;
      c = page.data.length === 0 || skip >= page.total || skip > MAX_SKIP ? { ...c, phase: "done", skip: 0 } : { ...c, skip };
      yield { events: events(page.data), cursor: cursor() };
    }
  }

  return {
    source: "docusign",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => docusignConnectEvents(body, options.accountId, { receivedAt: now().toISOString(), customerKey }, now()),
    writes: DOCUSIGN_WRITES,
  };
}
