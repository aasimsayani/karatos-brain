import { createHmac, timingSafeEqual } from "node:crypto";
import { docusignGuid } from "./client.js";
import { docusignEnvelopeEvents, docusignTime, type DocusignBrainEvent, type DocusignContext } from "./normalize.js";

/**
 * Docusign Connect, its webhooks, in the JSON SIM format with the envelope
 * summary and recipients included. Each delivery carries one signature per
 * HMAC key set on the Connect configuration, in `X-Docusign-Signature-1`,
 * `-2` and so on: the base64 HMAC-SHA256 of the raw body. One that matches
 * any of the keys is trusted.
 *
 * Docusign signs no timestamp, so a captured delivery stays valid. Replays
 * are handled two ways: a delivery generated more than a day ago gives no
 * events (the scheduled sync reads anything older), and the event keys are
 * the sync's own, so a replay stores nothing twice.
 */

export type DocusignSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/** Docusign allows up to 100 HMAC keys on one configuration. */
export const DOCUSIGN_MAX_HMAC_KEYS = 100;
/** A delivery generated longer ago than this gives no events; the sync reads it instead. */
export const DOCUSIGN_STALE_DELIVERY_MS = 24 * 3_600_000;
/** A base64 HMAC-SHA256: 43 characters and one pad. */
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

/** The signature headers of a delivery, from a header lookup such as `(name) => request.headers.get(name)`. */
export function docusignSignatures(header: (name: string) => string | null | undefined): string[] {
  const out: string[] = [];
  for (let i = 1; i <= DOCUSIGN_MAX_HMAC_KEYS; i++) {
    const value = header(`x-docusign-signature-${i}`);
    if (typeof value === "string") out.push(value);
  }
  return out;
}

/**
 * Checks a delivery's signatures against the raw body, in constant time.
 * Check before parsing the body. Docusign says to drop any `"` from a key.
 */
export function verifyDocusignConnect(keys: readonly string[], rawBody: string | Buffer, signatures: readonly string[]): DocusignSignatureCheck {
  const secrets = keys.map((k) => k.replace(/"/g, "").trim()).filter(Boolean);
  if (secrets.length === 0 || signatures.length === 0) return { ok: false, reason: "missing" };
  const given = signatures.map((s) => s.trim()).filter((s) => SIGNATURE.test(s));
  if (given.length === 0) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest();
    // Every pair is compared, so the time taken doesn't say which matched.
    for (const s of given) if (timingSafeEqual(Buffer.from(s, "base64"), expected)) ok = true;
  }
  return ok ? { ok: true } : { ok: false, reason: "mismatch" };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const EVENT = /^(envelope|recipient)-[a-z-]{1,40}$/;

/**
 * Events for one verified delivery. A delivery for another account, a stale
 * one, one that isn't an envelope or recipient event, or one without its
 * envelope summary gives none.
 */
export function docusignConnectEvents(body: unknown, accountId: string, ctx: DocusignContext, now: Date): DocusignBrainEvent[] {
  if (!isObject(body) || typeof body.event !== "string" || !EVENT.test(body.event) || !isObject(body.data)) return [];
  const data = body.data;
  const account = docusignGuid(accountId);
  if (!account || docusignGuid(data.accountId) !== account) return [];
  const generated = docusignTime(body.generatedDateTime);
  if (!generated || now.getTime() - Date.parse(generated) > DOCUSIGN_STALE_DELIVERY_MS) return [];
  const summary = data.envelopeSummary;
  if (!isObject(summary) || docusignGuid(summary.envelopeId) === undefined || docusignGuid(summary.envelopeId) !== docusignGuid(data.envelopeId)) return [];
  return docusignEnvelopeEvents(summary, ctx);
}
