import { formCustomerRefs } from "./customer.js";
import { SUBMISSION_KINDS, type ContactChannel, type FormField, type FormProfile, type SubmissionKind } from "./profile.js";

/**
 * Turns a form submission, from Typeform or a signed website form, into one
 * forms.submission_received event. Submissions are the most personal data
 * Brain A reads: names, emails, phone numbers, descriptions in the
 * customer's own words and photos. So the event is built from the profile's
 * safe fields only, and everything else is dropped before it is stored:
 *
 * - a date or time is kept when it is a real date or a clock time;
 * - item type, metal, stone, budget, store and time slot keep the profile
 *   value a typed answer matches, or the label of a choice the form itself
 *   offers. Typed words that match nothing, and a choice's "other" text, are
 *   dropped;
 * - the preferred contact channel is one of a few fixed values;
 * - the email address and phone number only make keyed customer references
 *   (customer.ts) and are never kept;
 * - names, addresses, descriptions, file and link answers, hidden fields,
 *   scores, variables and browser details are never read at all. Files are
 *   counted, so repairs can see a photo came with the request.
 *
 * A request isn't yet a repair ticket or a custom order (those need a
 * price, a promise date and a description), so it has its own event type
 * rather than repair.received or custom_order.created.
 *
 * Each submission is keyed by provider, form and response id, so the same
 * Typeform response read by the sync and delivered by a webhook is stored
 * once, and a replay is a duplicate.
 */

export const FORM_SUBMISSION_EVENT = "forms.submission_received";

/** What an answer is, as far as keeping it goes. */
export type FormAnswerKind = "choice" | "text" | "email" | "phone" | "date" | "number" | "boolean" | "file" | "other";

/** One answer, cut down to what the profile can map. */
export interface FormAnswer {
  /** The question's ref, id and title, any of which a profile may name it by. */
  names: string[];
  kind: FormAnswerKind;
  /** Choice labels, typed text or a date. Empty for numbers, files and anything not read. */
  values: string[];
  number?: number;
}

export interface FormSubmission {
  provider: "typeform" | "webhook";
  formId: string;
  /** Typeform's response id (its token), or the website's own submission id. */
  responseId: string;
  submittedAt: string | undefined;
  /** The form's title, used only to tell which kind of request it takes; never stored. */
  formTitle?: string;
  /** A kind the sender stated, such as a website form that only takes repairs. */
  kind?: SubmissionKind;
  answers: FormAnswer[];
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface FormBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const FORM_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const RESPONSE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?$/i;
/** Answers longer than this are cut before any pattern sees them; customers' text is never kept, only matched. */
export const ANSWER_MATCH_MAX = 200;
/** A typed answer as patterns see it: trimmed, inner spaces collapsed, and cut short, so no pattern can run slow on it. */
const forMatching = (value: string) => value.slice(0, ANSWER_MATCH_MAX * 4).replace(/\s+/g, " ").trim().slice(0, ANSWER_MATCH_MAX);
const LABEL_MAX = 80;

const CHANNEL_RULES: [RegExp, ContactChannel][] = [
  [/\b(text|sms|imessage|whatsapp)\b/i, "text"],
  [/\b(e-?mail)\b/i, "email"],
  [/\b(video|zoom|facetime|virtual)\b/i, "video"],
  [/\b(phone|call|telephone)\b/i, "phone"],
  [/\b(in[- ]?person|in[- ]?store|visit|stop by)\b/i, "in_person"],
];

/** A question name as compared: lowercase letters and digits only. */
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const list = (names: string | string[] | undefined) => (names === undefined ? [] : Array.isArray(names) ? names : [names]).map(squash).filter(Boolean);

/** The answers a profile field names, in the form's order. */
function answersFor(profile: FormProfile, field: FormField, answers: readonly FormAnswer[]): FormAnswer[] {
  const wanted = new Set(list(profile.fields[field]));
  if (wanted.size === 0) return [];
  return answers.filter((a) => a.names.some((n) => wanted.has(squash(n))));
}

/** A real calendar day, as YYYY-MM-DD. */
function isoDay(value: string): string | undefined {
  const m = ISO_DATE.exec(value.trim().slice(0, 10));
  if (!m) return undefined;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.toISOString().slice(0, 10) === m[0] ? m[0] : undefined;
}

/** A clock time, as HH:MM. "2pm", "2:30 PM" and "14:30" all read. */
function clockTime(value: string): string | undefined {
  const m = CLOCK.exec(forMatching(value));
  if (!m) return undefined;
  let hours = Number(m[1]);
  const minutes = Number(m[2] ?? "0");
  const half = m[3]?.toLowerCase().replace(/\./g, "");
  if (half && (hours < 1 || hours > 12)) return undefined;
  if (!half && m[2] === undefined) return undefined;
  if (half === "pm" && hours < 12) hours += 12;
  if (half === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * A field's value from its answers: the profile value an answer matches,
 * or the label of a choice the form offers. Typed text that matches none of
 * the profile's values is never kept.
 */
function category(profile: FormProfile, field: keyof FormProfile["values"], answers: readonly FormAnswer[], extra?: (value: string) => string | undefined): string | undefined {
  const rules = profile.values[field].map((rule) => ({ pattern: new RegExp(rule.match, "i"), value: rule.value }));
  for (const answer of answers) {
    if (answer.kind !== "choice" && answer.kind !== "text") continue;
    for (const value of answer.values) {
      const text = forMatching(value);
      const matched = rules.find((rule) => rule.pattern.test(text))?.value ?? extra?.(value);
      if (matched) return matched;
      // A label the form's author wrote, never the customer's own words.
      if (answer.kind === "choice" && value.trim()) return value.trim().slice(0, LABEL_MAX);
    }
  }
  return undefined;
}

/** One of a few fixed channels, so even a typed answer keeps none of its words. */
function channel(answers: readonly FormAnswer[]): ContactChannel | undefined {
  for (const answer of answers) {
    if (answer.kind !== "choice" && answer.kind !== "text") continue;
    for (const value of answer.values) {
      const text = forMatching(value);
      const found = CHANNEL_RULES.find(([pattern]) => pattern.test(text));
      if (found) return found[1];
    }
  }
  return undefined;
}

/** The stated kind, then the form's fixed kind, then the profile's rules on the kind question's answer and the form's title. */
function kindOf(profile: FormProfile, submission: FormSubmission, kindAnswers: readonly FormAnswer[]): SubmissionKind {
  if (submission.kind && SUBMISSION_KINDS.includes(submission.kind)) return submission.kind;
  const fixed = Object.hasOwn(profile.forms, submission.formId) ? profile.forms[submission.formId] : undefined;
  if (fixed) return fixed;
  const rules = profile.kinds.map((rule) => ({ pattern: new RegExp(rule.match, "i"), kind: rule.kind }));
  const texts = [...kindAnswers.flatMap((a) => (a.kind === "choice" || a.kind === "text" ? a.values : [])), submission.formTitle ?? ""];
  for (const text of texts) {
    const short = forMatching(text);
    const found = rules.find((rule) => rule.pattern.test(short));
    if (found) return found.kind;
  }
  return "other";
}

/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

export const formSubmissionRef = (provider: FormSubmission["provider"], formId: string, responseId: string) => `${provider}:${formId}:${responseId}`;

/**
 * The event for one submission. A submission without a form id or response
 * id can't be keyed, so it gives no event; one without a readable time
 * keeps occurredAt undefined, so the pipeline dead-letters it rather than
 * inventing a time.
 */
export function formSubmissionEvent(submission: FormSubmission, profile: FormProfile, customerKey: string, receivedAt: string): FormBrainEvent | null {
  if (!FORM_ID.test(submission.formId) || !RESPONSE_ID.test(submission.responseId)) return null;
  const answers = submission.answers;
  const by = (field: FormField) => answersFor(profile, field, answers);

  const emailAnswers = by("email");
  const phoneAnswers = by("phone");
  const email = (emailAnswers.length ? emailAnswers : answers.filter((a) => a.kind === "email")).flatMap((a) => a.values)[0];
  const phone = (phoneAnswers.length ? phoneAnswers : answers.filter((a) => a.kind === "phone")).flatMap((a) => a.values)[0];
  const refs = formCustomerRefs(customerKey, { email, phone });

  const dateAnswer = by("requestedDate").flatMap((a) => (a.kind === "date" || a.kind === "text" || a.kind === "choice" ? a.values : []));
  const requestedDate = dateAnswer.map(isoDay).find(Boolean);
  const budgetAnswers = by("budget");
  const budgetNumber = budgetAnswers.find((a) => a.kind === "number" && Number.isFinite(a.number) && a.number! >= 0 && a.number! <= 10_000_000)?.number;

  const fields = {
    requestedDate,
    requestedTime: category(profile, "requestedTime", by("requestedTime"), clockTime),
    itemType: category(profile, "itemType", by("itemType")),
    metal: category(profile, "metal", by("metal")),
    stone: category(profile, "stone", by("stone")),
    budgetAmount: budgetNumber === undefined ? undefined : Math.round(budgetNumber),
    budgetRange: budgetNumber === undefined ? category(profile, "budget", budgetAnswers) : undefined,
    preferredContact: channel(by("contactChannel")),
    storeLocation: category(profile, "storeLocation", by("storeLocation")),
  };
  // Fields the form answered that couldn't be kept safely, so the owner can tune the profile.
  const kept: Record<string, boolean> = {
    requestedDate: fields.requestedDate !== undefined,
    requestedTime: fields.requestedTime !== undefined,
    itemType: fields.itemType !== undefined,
    metal: fields.metal !== undefined,
    stone: fields.stone !== undefined,
    budget: fields.budgetAmount !== undefined || fields.budgetRange !== undefined,
    contactChannel: fields.preferredContact !== undefined,
    storeLocation: fields.storeLocation !== undefined,
  };
  const dropped = Object.keys(kept).filter((field) => !kept[field] && by(field as FormField).length > 0);

  const ref = formSubmissionRef(submission.provider, submission.formId, submission.responseId);
  const time = submission.submittedAt && !Number.isNaN(Date.parse(submission.submittedAt)) ? new Date(submission.submittedAt).toISOString() : undefined;
  return {
    id: `custom_forms_${ref.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
    type: FORM_SUBMISSION_EVENT,
    occurredAt: time,
    receivedAt,
    idempotencyKey: `custom_forms:${ref}`,
    payload: defined({
      submissionId: ref,
      provider: submission.provider,
      formId: submission.formId,
      kind: kindOf(profile, submission, by("kind")),
      submittedAt: time,
      customerRef: refs[0],
      contactRefs: refs,
      ...fields,
      attachmentCount: answers.filter((a) => a.kind === "file").length,
      unmappedFields: dropped.length ? dropped : undefined,
      profile: profile.id,
    }),
  };
}
