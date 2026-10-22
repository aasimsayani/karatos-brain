import { HUBSPOT_ID, hubSpotModifiedProperty, type HubSpotObject } from "./client.js";

/**
 * Turns HubSpot CRM records into Brain A events. Contacts become clienteling
 * profiles, in the shape Shopify's and Stripe's customers take; companies,
 * deals, tickets and engagements keep a neutral CRM shape (crm.company_updated,
 * crm.deal_updated, crm.ticket_updated, crm.engagement_logged), and archived
 * records become crm.record_deleted.
 *
 * Only a display name is kept from anything personal: no email addresses,
 * phone numbers, street addresses, notes, email bodies, meeting descriptions
 * or call recordings. An engagement keeps its kind, its time and the contacts
 * and deals it's linked to. Marketing consent is always off: HubSpot's
 * subscription and legal-basis data isn't read, so the connector never says a
 * contact may be contacted.
 *
 * Deal amounts are decimal strings in the deal's currency; they become whole
 * cents here. HubSpot has no version number, so a key of object, id and last
 * modified time stores every version once, and a replay is a duplicate.
 */

/** A record as HubSpot's search, list and webhook-free reads return it. */
export interface HubSpotRecord {
  id?: unknown;
  properties?: Record<string, unknown>;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
  archivedAt?: unknown;
}

/** The ids each record is associated with, by the associated object: { contacts: { "501": ["1", "2"] } }. */
export type HubSpotLinks = Partial<Record<"contacts" | "companies" | "deals", Record<string, string[]>>>;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface HubSpotBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** The singular name each object's events and references use. */
export const HUBSPOT_ENTITIES: Record<HubSpotObject, string> = {
  companies: "company",
  contacts: "contact",
  deals: "deal",
  tickets: "ticket",
  calls: "call",
  emails: "email",
  meetings: "meeting",
  notes: "note",
  tasks: "task",
};

/** Linked ids kept per association, so one busy record can't make an event huge. */
const MAX_LINKS = 100;
const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;
const MILLIS = /^\d{1,15}$/;

export const hubSpotRef = (entity: string, id: string) => `hubspot:${entity}:${id}`;

/**
 * A time HubSpot wrote, as an ISO time in UTC. Properties hold ISO strings or
 * millisecond times (engagement timestamps accept both); anything else is
 * undefined, so the pipeline dead-letters the record rather than inventing a time.
 */
export function hubSpotTime(value: unknown): string | undefined {
  const ms =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && MILLIS.test(value.trim())
        ? Number(value.trim())
        : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value.trim())
          ? Date.parse(value.trim())
          : Number.NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A decimal amount, written as a string or a number, in whole cents. Null for anything else. */
export function hubSpotCents(amount: unknown): number | null {
  const text = typeof amount === "number" && Number.isFinite(amount) ? String(amount) : typeof amount === "string" ? amount.trim() : "";
  return DECIMAL.test(text) ? Math.round(Number(text) * 100) : null;
}

/** When the record last changed: its last-modified property, else updatedAt. */
export const hubSpotModified = (object: HubSpotObject, record: HubSpotRecord) => hubSpotTime(record.properties?.[hubSpotModifiedProperty(object)]) ?? hubSpotTime(record.updatedAt);

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const id = (value: unknown) => (typeof value === "string" && HUBSPOT_ID.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined);
/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): HubSpotBrainEvent {
  return { id: `hubspot_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `hubspot:${key}`, payload };
}

/** The references to one record's linked records of one kind, as hubspot:<entity>:<id>. */
function linked(links: HubSpotLinks, to: "contacts" | "companies" | "deals", recordId: string): string[] {
  const ids = links[to]?.[recordId] ?? [];
  return [...new Set(ids.filter((i) => HUBSPOT_ID.test(i)))].slice(0, MAX_LINKS).map((i) => hubSpotRef(HUBSPOT_ENTITIES[to], i));
}

/** The event type and payload for one record. Only the fields named here are kept; everything else HubSpot sends is dropped. */
function payloadFor(object: HubSpotObject, p: Record<string, unknown>, recordId: string, links: HubSpotLinks): { type: string; payload: Record<string, unknown> } {
  const ref = hubSpotRef(HUBSPOT_ENTITIES[object], recordId);
  switch (object) {
    case "contacts": {
      const name = [text(p.firstname, 100), text(p.lastname, 100)].filter(Boolean).join(" ");
      return { type: "customer.profile_updated", payload: { customerId: ref, name: name || `HubSpot contact ${recordId}`, marketingConsent: false } };
    }
    case "companies":
      return { type: "crm.company_updated", payload: { companyId: ref, name: text(p.name) ?? `HubSpot company ${recordId}` } };
    case "deals":
      return {
        type: "crm.deal_updated",
        payload: defined({
          dealId: ref,
          name: text(p.dealname) ?? `HubSpot deal ${recordId}`,
          pipeline: text(p.pipeline, 60),
          stage: text(p.dealstage, 60),
          amountCents: p.amount === undefined || p.amount === null || p.amount === "" ? undefined : hubSpotCents(p.amount),
          currency: text(p.deal_currency_code, 3)?.toUpperCase(),
          closeDate: hubSpotTime(p.closedate)?.slice(0, 10),
          contactIds: linked(links, "contacts", recordId),
          companyIds: linked(links, "companies", recordId),
        }),
      };
    case "tickets":
      return {
        type: "crm.ticket_updated",
        payload: defined({
          ticketId: ref,
          pipeline: text(p.hs_pipeline, 60),
          status: text(p.hs_pipeline_stage, 60),
          priority: text(p.hs_ticket_priority, 20)?.toLowerCase(),
          contactIds: linked(links, "contacts", recordId),
          companyIds: linked(links, "companies", recordId),
        }),
      };
    default:
      // Engagements: the kind and when it happened, never what was said.
      return {
        type: "crm.engagement_logged",
        payload: defined({
          engagementId: ref,
          kind: HUBSPOT_ENTITIES[object],
          at: hubSpotTime(p.hs_timestamp),
          contactIds: linked(links, "contacts", recordId),
          dealIds: linked(links, "deals", recordId),
        }),
      };
  }
}

/**
 * The event for one HubSpot record. A record with no usable id is dropped,
 * since there is nothing to key it by; one with no last-modified time has no
 * occurredAt and is dead-lettered with the raw record kept.
 */
export function hubSpotEvents(object: HubSpotObject, record: HubSpotRecord, links: HubSpotLinks, receivedAt: string): HubSpotBrainEvent[] {
  if (!record || typeof record !== "object") return [];
  const recordId = id(record.id);
  if (!recordId) return [];
  const occurredAt = hubSpotModified(object, record);
  const version = occurredAt ? String(Date.parse(occurredAt)) : "0";
  const properties = record.properties && typeof record.properties === "object" ? record.properties : {};
  const { type, payload } = payloadFor(object, properties, recordId, links);
  return [event(`${HUBSPOT_ENTITIES[object]}:${recordId}:${version}`, type, occurredAt, receivedAt, payload)];
}

/** Every event in one page of changed records. */
export function hubSpotPageEvents(object: HubSpotObject, records: unknown, links: HubSpotLinks, receivedAt: string): HubSpotBrainEvent[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => hubSpotEvents(object, r as HubSpotRecord, links, receivedAt));
}

/**
 * A crm.record_deleted event for an archived record, keyed by when it was
 * archived, so a record restored and archived again is recorded again.
 */
export function hubSpotDeletionEvents(object: HubSpotObject, records: unknown, receivedAt: string): HubSpotBrainEvent[] {
  if (!Array.isArray(records)) return [];
  const entity = HUBSPOT_ENTITIES[object];
  return records.flatMap((raw) => {
    const r = raw as HubSpotRecord;
    const recordId = r && typeof r === "object" ? id(r.id) : undefined;
    if (!recordId) return [];
    const at = hubSpotTime(r.archivedAt) ?? hubSpotTime(r.updatedAt);
    return [event(`${entity}:${recordId}:deleted:${at ? Date.parse(at) : 0}`, "crm.record_deleted", at, receivedAt, { recordId: hubSpotRef(entity, recordId), entity })];
  });
}

