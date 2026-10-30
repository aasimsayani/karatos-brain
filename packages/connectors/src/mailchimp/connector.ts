import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { MAILCHIMP_PAGE_SIZE, mailchimpClient, type MailchimpClient, type MailchimpClientOptions } from "./client.js";
import { mailchimpCampaignEvent, mailchimpListEvent, mailchimpMemberEvents, mailchimpReportEvents, type MailchimpBrainEvent, type MailchimpContext } from "./normalize.js";

/**
 * Reads audiences, their members and sent campaigns with their reports. The
 * historical import reads every audience and member, and campaigns sent in
 * the last five years, 1000 at a time. Incremental syncs read the audiences
 * again, the members changed since the previous pass started, and the
 * campaigns sent in the 30 days before it, since a report keeps growing as
 * opens and clicks come in.
 *
 * Members are read oldest change first, so a pass cut short resumes from its
 * page; a member changed mid-pass is read again on the next one.
 */

/** Declared so it can be gated and audited; it never runs while writes are off. */
export const MAILCHIMP_WRITES: WriteAction[] = [{ integration: "mailchimp", name: "add_audience_member", description: "Add a contact to an audience, with their consent" }];

/** Each incremental pass reads campaigns sent this far before the previous pass, as their reports keep changing. */
export const MAILCHIMP_REPORT_DAYS = 30;
/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const MAILCHIMP_OVERLAP_MS = 5 * 60_000;

type Step = "lists" | "members" | "campaigns" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface MailchimpCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The audiences found by the lists step, read in order by the members step. */
  lists: string[];
  listIndex: number;
  offset: number;
  /** Historical: campaigns sent from this time. Incremental: members changed from this time. */
  since: string;
  /** The time the next incremental pass reads from. */
  nextFrom: string;
}

export interface MailchimpConnectorOptions extends MailchimpClientOptions {
  /** CUSTOMER_REF_KEY: members become keyed references, never email addresses. */
  customerKey: string;
  historyYears?: number;
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: MailchimpClient;
}

const STEPS: Step[] = ["lists", "members", "campaigns", "done"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const LIST_ID = /^[A-Za-z0-9]{1,32}$/;
const DAY_MS = 86_400_000;

export function parseMailchimpCursor(raw: string | null): MailchimpCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as MailchimpCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !Array.isArray(c.lists) ||
    !c.lists.every((l) => typeof l === "string" && LIST_ID.test(l)) ||
    !Number.isInteger(c.listIndex) ||
    c.listIndex < 0 ||
    !Number.isInteger(c.offset) ||
    c.offset < 0 ||
    ![c.since, c.nextFrom].every((t) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)))
  ) {
    throw new Error("Mailchimp checkpoint is not in the expected shape");
  }
  return c;
}

const rows = (body: Record<string, unknown>, key: string) => (Array.isArray(body[key]) ? (body[key] as unknown[]) : []);

export function mailchimpConnector(options: MailchimpConnectorOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? mailchimpClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startHistorical(): MailchimpCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return { pass: "historical", step: "lists", lists: [], listIndex: 0, offset: 0, since: start.toISOString(), nextFrom: now().toISOString() };
  }

  function startIncremental(previous: MailchimpCursor | null): MailchimpCursor {
    const since = previous?.nextFrom ?? new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    return { pass: "incremental", step: "lists", lists: [], listIndex: 0, offset: 0, since, nextFrom: new Date(now().getTime() - MAILCHIMP_OVERLAP_MS).toISOString() };
  }

  /** Moves past a step that is finished. */
  const after = (c: MailchimpCursor): MailchimpCursor => {
    if (c.step === "lists") return { ...c, step: c.lists.length ? "members" : "campaigns", listIndex: 0, offset: 0 };
    if (c.step === "members" && c.listIndex + 1 < c.lists.length) return { ...c, listIndex: c.listIndex + 1, offset: 0 };
    return { ...c, step: STEPS[STEPS.indexOf(c.step) + 1]!, offset: 0 };
  };

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMailchimpCursor(context.cursor);
    let cursor: MailchimpCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const ctx: MailchimpContext = { customerKey, receivedAt: now().toISOString() };
      const events: MailchimpBrainEvent[] = [];
      let found: unknown[];
      if (cursor.step === "lists") {
        found = rows(await client.get("lists", { offset: cursor.offset }), "lists");
        const ids: string[] = [];
        for (const list of found) {
          const e = mailchimpListEvent(list, ctx);
          if (!e) continue;
          events.push(e);
          ids.push(String((list as { id: string }).id));
        }
        cursor = { ...cursor, lists: [...cursor.lists, ...ids.filter((l) => !cursor.lists.includes(l))] };
      } else if (cursor.step === "members") {
        const listId = cursor.lists[cursor.listIndex];
        if (listId === undefined) throw new Error("Mailchimp checkpoint is not in the expected shape");
        found = rows(await client.get("members", { listId, offset: cursor.offset, ...(cursor.pass === "incremental" ? { sinceLastChanged: cursor.since } : {}) }), "members");
        for (const member of found) events.push(...mailchimpMemberEvents(member, listId, ctx));
      } else {
        const sentFrom = cursor.pass === "historical" ? cursor.since : new Date(Date.parse(cursor.since) - MAILCHIMP_REPORT_DAYS * DAY_MS).toISOString();
        found = rows(await client.get("campaigns", { offset: cursor.offset, sinceSendTime: sentFrom }), "campaigns");
        for (const campaign of found) {
          const e = mailchimpCampaignEvent(campaign, ctx);
          if (!e) continue;
          events.push(e);
          const campaignId = String((campaign as { id: string }).id);
          events.push(...mailchimpReportEvents(await client.get("report", { campaignId }), ctx));
        }
      }
      // A full page may have more behind it; a short or empty one is the last.
      cursor = found.length >= MAILCHIMP_PAGE_SIZE ? { ...cursor, offset: cursor.offset + MAILCHIMP_PAGE_SIZE } : after(cursor);
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "mailchimp",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: MAILCHIMP_WRITES,
  };
}
