import { createHmac, timingSafeEqual } from "node:crypto";
import { formSubmissionEvent, type FormAnswer, type FormBrainEvent, type FormSubmission } from "./normalize.js";
import { SUBMISSION_KINDS, type FormProfile, type SubmissionKind } from "./profile.js";
import { typeformFieldTitles, typeformSubmission, TYPEFORM_FORM_ID, type TypeformResponseItem } from "./typeform.js";

/**
 * Form submissions arrive by webhook two ways. Typeform signs each delivery
 * with the secret set on the webhook. Any other form tool, or a jeweler's
 * own website form, signs its POST the KaratOS way: an HMAC-SHA256 over a
 * timestamp and the raw body, so a delivery replayed more than five minutes
 * later is refused. Check the signature before parsing the body; anything
 * but ok must be answered 401.
 */

export type FormSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" | "expired" };

const bytes = (rawBody: string | Buffer) => (typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
const same = (given: Buffer, expected: Buffer) => given.length === expected.length && timingSafeEqual(given, expected);

/**
 * Checks `Typeform-Signature`: `sha256=` and the base64 HMAC-SHA256 of the
 * raw body, keyed with the webhook's secret. Typeform signs no timestamp,
 * so a replayed delivery can't be told apart; it carries a response
 * already stored, so it is counted as a duplicate.
 */
export function verifyTypeformWebhook(secret: string, rawBody: string | Buffer, header: string | undefined): FormSignatureCheck {
  if (!secret || !header) return { ok: false, reason: "missing" };
  const m = /^sha256=([A-Za-z0-9+/]{43}=)$/.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(bytes(rawBody)).digest();
  return same(Buffer.from(m[1]!, "base64"), expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The headers a signed form submission carries. */
export const FORM_TIMESTAMP_HEADER = "x-karatos-timestamp";
export const FORM_SIGNATURE_HEADER = "x-karatos-signature";
/** A signature more than five minutes from the instance's clock, either way, is refused. */
export const FORM_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The headers for a submission, for a sender written in Node. Others sign
 * the same way: HMAC-SHA256, keyed with WEBHOOK_SIGNING_SECRET, over the
 * Unix time in seconds, a full stop and the exact body bytes sent, in hex.
 */
export function signFormWebhook(secret: string, rawBody: string | Buffer, nowSeconds: number): Record<string, string> {
  const t = String(Math.floor(nowSeconds));
  const mac = createHmac("sha256", secret).update(`${t}.`, "utf8").update(bytes(rawBody)).digest("hex");
  return { [FORM_TIMESTAMP_HEADER]: t, [FORM_SIGNATURE_HEADER]: `v1=${mac}` };
}

/**
 * Checks a signed form submission: `X-KaratOS-Signature: v1=<hex>` over
 * `<X-KaratOS-Timestamp>.<raw body>`, within five minutes of `nowSeconds`.
 */
export function verifyFormWebhook(
  secret: string,
  rawBody: string | Buffer,
  headers: { timestamp: string | undefined; signature: string | undefined },
  nowSeconds: number,
  toleranceSeconds = FORM_SIGNATURE_TOLERANCE_SECONDS,
): FormSignatureCheck {
  if (!secret || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing" };
  const t = headers.timestamp.trim();
  const m = /^v1=([0-9a-f]{64})$/.exec(headers.signature.trim());
  if (!/^\d{1,12}$/.test(t) || !m) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(`${t}.`, "utf8").update(bytes(rawBody)).digest();
  if (!same(Buffer.from(m[1]!, "hex"), expected)) return { ok: false, reason: "mismatch" };
  if (Math.abs(nowSeconds - Number(t)) > toleranceSeconds) return { ok: false, reason: "expired" };
  return { ok: true };
}

export interface FormWebhookOptions {
  profile: FormProfile;
  customerKey: string;
  receivedAt: string;
}

/**
 * Events for one verified Typeform delivery. Only form_response deliveries
 * for the forms the instance reads give one; anything else gives none.
 */
export function typeformWebhookEvents(body: unknown, forms: readonly string[], options: FormWebhookOptions): FormBrainEvent[] {
  const b = (body ?? {}) as { event_type?: unknown; form_response?: unknown };
  if (b.event_type !== "form_response" || !b.form_response || typeof b.form_response !== "object") return [];
  const response = b.form_response as TypeformResponseItem & { form_id?: unknown; definition?: { title?: unknown } };
  const formId = typeof response.form_id === "string" && TYPEFORM_FORM_ID.test(response.form_id) ? response.form_id : undefined;
  if (!formId || !forms.includes(formId)) return [];
  const title = typeof response.definition?.title === "string" ? response.definition.title : undefined;
  const submission = typeformSubmission(formId, response, typeformFieldTitles(response.definition), title);
  const event = formSubmissionEvent(submission, options.profile, options.customerKey, options.receivedAt);
  return event ? [event] : [];
}

/**
 * A signed form submission's body:
 *
 *     { "id": "sub_123", "form": "repair-intake", "submittedAt": "2026-10-22T15:04:05Z",
 *       "kind": "repair_intake", "fields": { "item type": "Ring", "email": "..." } }
 *
 * `kind` and `title` are optional. Field values are text, numbers, true or false, or
 * lists of text. Every value is treated as typed by the customer, so only
 * values matching the profile are kept.
 */
export interface SignedFormBody {
  id: string;
  form: string;
  /** The form's name, such as "Repair intake"; the form id is used when absent. Only tells the kind of request. */
  title?: string;
  submittedAt: string;
  kind?: SubmissionKind;
  fields: Record<string, unknown>;
}

function webhookAnswer(name: string, value: unknown): FormAnswer | null {
  if (typeof value === "string") return { names: [name], kind: "text", values: [value] };
  if (typeof value === "number" && Number.isFinite(value)) return { names: [name], kind: "number", values: [], number: value };
  if (typeof value === "boolean") return { names: [name], kind: "boolean", values: [] };
  if (Array.isArray(value)) {
    const values = value.filter((v): v is string => typeof v === "string");
    return values.length ? { names: [name], kind: "text", values } : null;
  }
  return null;
}

/** The event for one verified signed form submission, or none when the body isn't shaped like one. */
export function formWebhookEvents(body: unknown, options: FormWebhookOptions): FormBrainEvent[] {
  const b = (body ?? {}) as Partial<SignedFormBody>;
  if (typeof b.id !== "string" || typeof b.form !== "string" || !b.fields || typeof b.fields !== "object" || Array.isArray(b.fields)) return [];
  const kind = SUBMISSION_KINDS.find((k) => k === b.kind);
  const submission: FormSubmission = {
    provider: "webhook",
    formId: b.form,
    responseId: b.id,
    submittedAt: typeof b.submittedAt === "string" ? b.submittedAt : undefined,
    // The website's own name for the form tells the kind when nothing else does, as a Typeform title would.
    formTitle: typeof b.title === "string" ? b.title.slice(0, 200) : b.form.replace(/[-_]+/g, " "),
    ...(kind ? { kind } : {}),
    answers: Object.entries(b.fields)
      .slice(0, 200)
      .map(([name, value]) => webhookAnswer(name, value))
      .filter((a): a is FormAnswer => a !== null),
  };
  // The website names its own fields, and may call the email "email", so email and phone are read by name only.
  const event = formSubmissionEvent(submission, options.profile, options.customerKey, options.receivedAt);
  return event ? [event] : [];
}
