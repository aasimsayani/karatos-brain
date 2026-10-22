import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "./customer.js";
import { formSubmissionEvent, type FormBrainEvent } from "./normalize.js";
import { GENERIC_FORM_PROFILE, type FormProfile } from "./profile.js";
import {
  TYPEFORM_FORM_ID,
  TYPEFORM_PAGE_SIZE,
  TYPEFORM_TOKEN,
  TypeformApiError,
  TypeformConfigError,
  checkTypeformRegion,
  typeformClient,
  typeformFieldTitles,
  typeformSubmission,
  type TypeformClient,
  type TypeformClientOptions,
  type TypeformResponseItem,
} from "./typeform.js";
import { typeformWebhookEvents } from "./webhooks.js";

/**
 * Reads appointment requests, repair intake and custom order requests from
 * Typeform forms, and takes signed submissions from any other form by
 * webhook (webhooks.ts). The historical import reads each form's completed
 * responses from the last five years; incremental syncs read what was
 * submitted since the previous pass started. Typeform answers newest first
 * and pages back with `before`, the last response's token, between fixed
 * since and until times, so the pages stay put while new responses arrive.
 * Responses can't be edited once submitted, so there are no changes to
 * follow; a deleted response simply stops coming back.
 */

/** None: the connector only reads. Declared empty so the write gate has nothing to allow. */
export const CUSTOM_FORMS_WRITES: WriteAction[] = [];

/** Each incremental pass starts this long before the previous one did, so a response saved mid-pass is never missed. */
export const CUSTOM_FORMS_OVERLAP_MS = 5 * 60_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface CustomFormsCursor {
  pass: "historical" | "incremental";
  /** The form being read, or null once every form is read. */
  form: string | null;
  /** The token to page back from, or null for the newest page. */
  before: string | null;
  /** ISO times the pass reads between, inclusive. */
  since: string;
  until: string;
  /** ISO time the next incremental pass reads from. */
  nextFrom: string;
}

export interface CustomFormsConnectorOptions {
  /** Typeform form ids to read, from the form URLs. */
  forms: readonly string[];
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  profile?: FormProfile;
  typeform: TypeformClientOptions;
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from `typeform` otherwise. */
  client?: TypeformClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isTime = (t: unknown): t is string => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t));

export function parseCustomFormsCursor(raw: string | null): CustomFormsCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as CustomFormsCursor;
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !(c.form === null || (typeof c.form === "string" && TYPEFORM_FORM_ID.test(c.form))) ||
    !(c.before === null || (typeof c.before === "string" && TYPEFORM_TOKEN.test(c.before))) ||
    ![c.since, c.until, c.nextFrom].every(isTime) ||
    Date.parse(c.since) > Date.parse(c.until)
  ) {
    throw new Error("Custom forms checkpoint is not in the expected shape");
  }
  return c;
}

/** Form ids from TYPEFORM_FORM_IDS, comma-separated. */
export function parseTypeformFormIds(value: string | undefined): string[] {
  const ids = [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  const bad = ids.filter((id) => !TYPEFORM_FORM_ID.test(id));
  if (bad.length) throw new TypeformConfigError("TYPEFORM_FORM_IDS lists form ids, letters and digits only, separated by commas");
  if (ids.length === 0) throw new TypeformConfigError("set TYPEFORM_FORM_IDS to the forms to read");
  return ids;
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function customFormsConnector(options: CustomFormsConnectorOptions): Connector {
  const forms = parseTypeformFormIds(options.forms.join(","));
  const customerKey = checkCustomerRefKey(options.customerKey);
  const profile = options.profile ?? GENERIC_FORM_PROFILE;
  const client = options.client ?? typeformClient(options.typeform);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startHistorical(): CustomFormsCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const until = now().toISOString();
    return { pass: "historical", form: forms[0]!, before: null, since: start.toISOString(), until, nextFrom: until };
  }

  function startIncremental(previous: CustomFormsCursor | null): CustomFormsCursor {
    const since = previous?.nextFrom ?? new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    const until = now().toISOString();
    const nextFrom = new Date(now().getTime() - CUSTOM_FORMS_OVERLAP_MS).toISOString();
    // A clock set back can't make a pass read backwards.
    return { pass: "incremental", form: forms[0]!, before: null, since: Date.parse(since) > Date.parse(until) ? until : since, until, nextFrom };
  }

  const definitions = new Map<string, { titles: Map<string, string>; title: string | undefined }>();
  async function definition(formId: string) {
    let found = definitions.get(formId);
    if (!found) {
      const form = await client.get("form", formId);
      checkTypeformRegion(form, client.host);
      found = { titles: typeformFieldTitles(form), title: typeof form.title === "string" ? form.title : undefined };
      definitions.set(formId, found);
    }
    return found;
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseCustomFormsCursor(context.cursor);
    let cursor: CustomFormsCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes, unless its form is no longer read.
      cursor = saved?.pass === "historical" && (saved.form === null || forms.includes(saved.form)) ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.form !== null && forms.includes(saved.form) ? saved : startIncremental(saved);
    }

    while (cursor.form !== null) {
      const formId = cursor.form;
      const { titles, title } = await definition(formId);
      const body = await client.get("responses", formId, {
        since: seconds(cursor.since),
        until: seconds(cursor.until),
        ...(cursor.before ? { before: cursor.before } : {}),
      });
      const items = (Array.isArray(body.items) ? body.items : []) as TypeformResponseItem[];
      const receivedAt = now().toISOString();
      const events = items
        .map((item) => formSubmissionEvent(typeformSubmission(formId, item, titles, title), profile, customerKey, receivedAt))
        .filter((e): e is FormBrainEvent => e !== null);
      // A full page may have more behind it; a short or empty one is the last for this form.
      const last = items.at(-1)?.token;
      if (items.length >= TYPEFORM_PAGE_SIZE && typeof last === "string" && TYPEFORM_TOKEN.test(last)) {
        // Paging back must move; the same page twice would loop for ever.
        if (last === cursor.before) throw new TypeformApiError("Typeform answered the same page of responses twice; the next run resumes from the checkpoint", 200);
        cursor = { ...cursor, before: last };
      } else {
        cursor = { ...cursor, form: forms[forms.indexOf(formId) + 1] ?? null, before: null };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "custom_forms",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    /** A verified Typeform delivery. Signed website submissions go through formWebhookEvents. */
    handleWebhook: (body) => typeformWebhookEvents(body, forms, { profile, customerKey, receivedAt: now().toISOString() }),
    writes: CUSTOM_FORMS_WRITES,
  };
}
