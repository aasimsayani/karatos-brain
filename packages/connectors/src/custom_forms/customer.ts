import { createHmac } from "node:crypto";

/**
 * A customer reference made from an email address or phone number without
 * keeping either. It is an HMAC-SHA256 keyed with the instance's own
 * CUSTOMER_REF_KEY, so the same person's submissions link up, but nobody
 * holding the events can test a guessed address against them without the
 * key, and two instances never share references. A plain hash wouldn't do:
 * email addresses are easy to guess and hash.
 *
 * Changing the key breaks every link already made, so it is never rotated.
 */

export const CUSTOMER_REF_PREFIX = "form_customer:";
const MIN_KEY_LENGTH = 32;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

export class CustomerRefKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerRefKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkCustomerRefKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new CustomerRefKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

/** An email address as the same person types it on different days: trimmed and lowercased. Undefined when it isn't one. */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return EMAIL.test(email) ? email : undefined;
}

/** A phone number as its digits only. Undefined with fewer than seven digits or more than fifteen, E.164's limit. */
export function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : undefined;
}

/** The reference for one contact detail. The kind is signed with it, so an email and a phone number never collide. */
export function formCustomerRef(key: string, kind: "email" | "phone", normalized: string): string {
  const mac = createHmac("sha256", checkCustomerRefKey(key)).update(`${kind}:${normalized}`, "utf8").digest("hex");
  return `${CUSTOMER_REF_PREFIX}${mac.slice(0, 32)}`;
}

/** References for whatever contact details a submission gave: email first, as it's the steadier one. */
export function formCustomerRefs(key: string, contact: { email?: unknown; phone?: unknown }): string[] {
  const email = normalizeEmail(contact.email);
  const phone = normalizePhone(contact.phone);
  return [...(email ? [formCustomerRef(key, "email", email)] : []), ...(phone ? [formCustomerRef(key, "phone", phone)] : [])];
}
