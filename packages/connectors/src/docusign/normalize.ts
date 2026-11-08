import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";
import { docusignGuid } from "./client.js";

/**
 * Turns a Docusign envelope, with its recipients, into one Brain A event:
 * `agreement.updated`, the state of an agreement sent for signature and who
 * has yet to sign it. Each version is keyed by the envelope and a hash of
 * what was read, so a replay is a duplicate and every change (sent, viewed,
 * signed, declined, completed, voided) is stored once.
 *
 * Agreements are personal, so the event keeps their shape and drops the
 * people and the words:
 *
 * - a recipient's email address only makes a keyed customer reference, the
 *   same one custom forms, Calendly and Klaviyo make, so a signed memo links
 *   to the same person's other records. The address isn't kept, and nor are
 *   names, phone numbers, decline reasons or anything typed into a field;
 * - the email subject only gives the agreement's kind (consignment, memo,
 *   appraisal and so on). The subject itself, which often names the
 *   customer, isn't kept, and nor is the message;
 * - documents are never downloaded.
 *
 * An envelope whose id isn't a GUID is dropped; one with no time that reads
 * is dead-lettered.
 */

export interface DocusignBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface DocusignContext {
  receivedAt: string;
  /** CUSTOMER_REF_KEY, which keys the customer references. */
  customerKey: string;
}

export const DOCUSIGN_EVENT_TYPE = "agreement.updated";

/** What an agreement is, read from its email subject. The subject isn't kept. */
export type AgreementKind = "consignment" | "memo" | "appraisal" | "custom_order" | "repair" | "purchase" | "sale" | "layaway" | "employment" | "confidentiality" | "vendor" | "other";
const KIND_RULES: [RegExp, AgreementKind][] = [
  [/\bconsign\w*/i, "consignment"],
  [/\bmemo(randum)?\b/i, "memo"],
  [/\b(apprais\w*|valuation)\b/i, "appraisal"],
  [/\b(custom|bespoke|commission\w*|design)\b/i, "custom_order"],
  [/\b(repair\w*|resiz\w*|restor\w*)\b/i, "repair"],
  [/\b(we buy|buy[- ]?back|purchase from|seller'?s? agreement|gold buying)\b/i, "purchase"],
  [/\b(layaway|lay[- ]away|payment plan)\b/i, "layaway"],
  [/\b(bill of sale|sales? (agreement|contract)|purchase (agreement|order)|invoice|receipt)\b/i, "sale"],
  [/\b(offer letter|employ\w*|onboarding|w-?4|i-?9|handbook)\b/i, "employment"],
  [/\b(nda|non-?disclosure|confidential\w*)\b/i, "confidentiality"],
  [/\b(vendor|supplier|wholesale|distribut\w*)\b/i, "vendor"],
];

const ENVELOPE_STATUSES = new Set(["created", "sent", "delivered", "signed", "completed", "declined", "voided", "deleted", "timedout", "processing", "correct", "authoritativecopy", "transfercompleted", "template"]);
const RECIPIENT_STATUSES = new Set(["created", "sent", "delivered", "signed", "completed", "declined", "autoresponded", "faxpending"]);
/** Recipient lists in an envelope, by the role they play. */
export const DOCUSIGN_RECIPIENT_ROLES = {
  signers: "signer",
  inPersonSigners: "in_person_signer",
  witnesses: "witness",
  notaries: "notary",
  agents: "agent",
  editors: "editor",
  intermediaries: "intermediary",
  carbonCopies: "copy",
  certifiedDeliveries: "certified_delivery",
  seals: "seal",
  participants: "participant",
} as const;
/** Roles that must act before an envelope completes. */
const ACTING = new Set(["signer", "in_person_signer", "witness", "notary", "seal", "participant"]);
const MAX_RECIPIENTS = 100;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A time Docusign wrote (it gives seven decimal places), as an ISO time in UTC. Anything unreadable is undefined. */
export function docusignTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}${(m[2] ?? "").slice(0, 4)}${m[3]}`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The agreement's kind, from its subject: the first rule that matches, in order. */
export function agreementKind(subject: unknown): AgreementKind {
  if (typeof subject !== "string") return "other";
  const text = subject.slice(0, 500);
  return KIND_RULES.find(([rule]) => rule.test(text))?.[1] ?? "other";
}

const status = (value: unknown, known: Set<string>) => (typeof value === "string" && known.has(value.toLowerCase()) ? value.toLowerCase() : value === undefined ? undefined : "unknown");
const small = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 9999 ? n : undefined;
};
const recipientId = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/.test(value) ? value : typeof value === "number" && Number.isInteger(value) && value >= 0 ? String(value) : undefined);

export interface DocusignRecipient {
  role: string;
  recipientId: string | undefined;
  routingOrder: number | undefined;
  status: string | undefined;
  sentAt: string | undefined;
  deliveredAt: string | undefined;
  signedAt: string | undefined;
  declinedAt: string | undefined;
  customerRefs: string[];
}

/** Every recipient of an envelope, by role, without their names or addresses. */
export function docusignRecipients(recipients: unknown, customerKey: string): DocusignRecipient[] {
  if (!isObject(recipients)) return [];
  const out: DocusignRecipient[] = [];
  for (const [list, role] of Object.entries(DOCUSIGN_RECIPIENT_ROLES)) {
    const people = recipients[list];
    if (!Array.isArray(people)) continue;
    for (const r of people) {
      if (!isObject(r) || out.length >= MAX_RECIPIENTS) continue;
      out.push({
        role,
        recipientId: recipientId(r.recipientId),
        routingOrder: small(r.routingOrder),
        status: status(r.status, RECIPIENT_STATUSES),
        sentAt: docusignTime(r.sentDateTime),
        deliveredAt: docusignTime(r.deliveredDateTime),
        signedAt: docusignTime(r.signedDateTime),
        declinedAt: docusignTime(r.declinedDateTime),
        // An in-person signer's own address is signerEmail; email there is the host's.
        customerRefs: formCustomerRefs(customerKey, { email: role === "in_person_signer" ? r.signerEmail : r.email }),
      });
    }
  }
  return out;
}

/** The time an envelope last changed: its status change, else its last change of any kind. */
export function docusignChangedAt(envelope: Record<string, unknown>): string | undefined {
  return docusignTime(envelope.statusChangedDateTime) ?? docusignTime(envelope.lastModifiedDateTime);
}

/** One envelope version. An envelope with no usable id is dropped. */
export function docusignEnvelopeEvents(envelope: unknown, ctx: DocusignContext): DocusignBrainEvent[] {
  const id = isObject(envelope) ? docusignGuid(envelope.envelopeId) : undefined;
  if (!id || !isObject(envelope)) return [];
  const recipients = docusignRecipients(envelope.recipients, ctx.customerKey);
  const acting = recipients.filter((r) => ACTING.has(r.role));
  const payload = defined({
    agreementId: `docusign:envelope:${id}`,
    kind: agreementKind(envelope.emailSubject),
    status: status(envelope.status, ENVELOPE_STATUSES),
    createdAt: docusignTime(envelope.createdDateTime),
    sentAt: docusignTime(envelope.sentDateTime),
    deliveredAt: docusignTime(envelope.deliveredDateTime),
    completedAt: docusignTime(envelope.completedDateTime),
    declinedAt: docusignTime(envelope.declinedDateTime),
    voidedAt: docusignTime(envelope.voidedDateTime),
    deletedAt: docusignTime(envelope.deletedDateTime),
    statusChangedAt: docusignTime(envelope.statusChangedDateTime),
    signers: acting.length,
    signed: acting.filter((r) => r.status === "signed" || r.status === "completed").length,
    awaitingSignature: acting.filter((r) => r.status === "created" || r.status === "sent" || r.status === "delivered").length,
    recipients: recipients.map((r) => defined({ ...r })),
  });
  const key = `envelope:${id}:${digest(payload)}`;
  return [{ id: `docusign_${key}`, type: DOCUSIGN_EVENT_TYPE, occurredAt: docusignChangedAt(envelope), receivedAt: ctx.receivedAt, idempotencyKey: `docusign:${key}`, payload }];
}
