import { createHmac } from "node:crypto";

/**
 * A customer reference made from an email address or phone number without
 * keeping either. It is an HMAC-SHA256 keyed with the instance's own
 * CUSTOMER_REF_KEY, so the same person's submissions link up, but nobody
 * holding the events can test a guessed address against them without the
 * key, and two instances never share references. A plain hash wouldn't do:
 * email addresses are easy to guess and hash.
 *
 * Phone numbers are hashed as their digits. A number typed the way people
 * do in North America, ten digits without the country code, also gets the
 * reference of its E.164 form (1 and the ten digits), the form Quo, Twilio,
 * WhatsApp and Klaviyo give, so a form, a help desk ticket or a booking
 * with "(212) 555-0123" lines up with a text from +1 212 555 0123. The
 * digits-only reference comes first and is unchanged, so earlier records
 * keep linking; see canonicalPhone for the rules.
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

/** An extension at the end of a number ("x12", "ext. 12", "#12"): the same person's line, so it is dropped. */
const EXTENSION = /\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i;
/** A North American number without its country code: an area code and an exchange that each start 2 to 9. */
const NANP_NATIONAL = /^[2-9]\d{2}[2-9]\d{6}$/;

/**
 * A phone number in its E.164 digits, the form the phone systems give, or
 * undefined when it can't be told. An extension is dropped, an international
 * prefix of 00 is dropped, and ten digits that read as a North American
 * number get the country code 1. Anything else is its digits, as
 * normalizePhone gives them. A ten-digit number from elsewhere written
 * without its + is read as North American; a number written with + never
 * is. Undefined outside seven to fifteen digits.
 */
export function canonicalPhone(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  if (text.length > 64) return undefined;
  let digits = text.replace(EXTENSION, "").replace(/\D/g, "");
  if (/^00[1-9]/.test(digits)) digits = digits.slice(2);
  if (NANP_NATIONAL.test(digits) && !text.trim().startsWith("+")) digits = `1${digits}`;
  return digits.length >= 7 && digits.length <= 15 ? digits : undefined;
}

/** The reference for one contact detail. The kind is signed with it, so an email and a phone number never collide. */
export function formCustomerRef(key: string, kind: "email" | "phone", normalized: string): string {
  const mac = createHmac("sha256", checkCustomerRefKey(key)).update(`${kind}:${normalized}`, "utf8").digest("hex");
  return `${CUSTOMER_REF_PREFIX}${mac.slice(0, 32)}`;
}

/**
 * References for whatever contact details a submission gave: email first, as it's the steadier one,
 * then the phone number's digits, then its E.164 form when that differs.
 */
export function formCustomerRefs(key: string, contact: { email?: unknown; phone?: unknown }): string[] {
  const email = normalizeEmail(contact.email);
  return [...(email ? [formCustomerRef(key, "email", email)] : []), ...phoneRefs(key, contact.phone)];
}

/**
 * The references for one phone number: its digits, as every earlier record has it, and its E.164 form
 * when that differs. None when neither reads.
 */
export function phoneRefs(key: string, value: unknown): string[] {
  const digits = normalizePhone(value);
  const e164 = canonicalPhone(value);
  return [...(digits ? [formCustomerRef(key, "phone", digits)] : []), ...(e164 && e164 !== digits ? [formCustomerRef(key, "phone", e164)] : [])];
}
