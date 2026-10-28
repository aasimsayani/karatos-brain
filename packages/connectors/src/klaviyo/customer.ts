import { createHmac } from "node:crypto";

/**
 * A Klaviyo profile becomes keyed references, never an email address, phone
 * number, name, location or custom property, and never Klaviyo's own
 * profile id either. Each is an HMAC-SHA256 keyed with the instance's
 * CUSTOMER_REF_KEY, the key custom forms, Square and WooCommerce use for
 * their customer references.
 *
 * Two kinds of reference:
 *
 * - The profile reference hashes Klaviyo's profile id. It never changes, so a
 *   profile's versions, its list and segment memberships and its consent
 *   changes link up.
 * - Contact references hash the normalized email address and phone number
 *   exactly as custom forms does (`form_customer:` and HMAC of `email:<addr>`
 *   or `phone:<digits>`), so a Klaviyo profile lines up with a person who
 *   filled in a form. Square and WooCommerce hash their own customer ids,
 *   which Klaviyo doesn't know, so an id can't link Klaviyo to them; the
 *   email address is the one detail both sides hold.
 *
 * The derivation must stay byte for byte the same as custom forms'
 * formCustomerRef; a test pins a vector computed with that code.
 *
 * Changing the key breaks every link already made, so it is never rotated.
 */

export const KLAVIYO_PROFILE_PREFIX = "klaviyo:profile:";
/** Custom forms' prefix for contact references. Shared on purpose, so the same person gets the same reference. */
export const CONTACT_REF_PREFIX = "form_customer:";
const MIN_KEY_LENGTH = 32;
/** Klaviyo profile ids: letters and digits (26-character ULIDs today). */
const PROFILE_ID = /^[A-Za-z0-9]{1,64}$/;
/** Custom forms' email pattern. The longest address it accepts is 382 characters, so longer input is refused before matching. */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
const EMAIL_MAX = 382;

export class KlaviyoCustomerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KlaviyoCustomerKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkKlaviyoCustomerKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new KlaviyoCustomerKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

const mac = (key: string, message: string) => createHmac("sha256", checkKlaviyoCustomerKey(key)).update(message, "utf8").digest("hex").slice(0, 32);

/** The reference for one Klaviyo profile id, or undefined when there is no usable id. */
export function klaviyoProfileRef(key: string, id: unknown): string | undefined {
  if (typeof id !== "string" || id.length > 64 || !PROFILE_ID.test(id)) return undefined;
  return `${KLAVIYO_PROFILE_PREFIX}${mac(key, `klaviyo:profile:v1:${id}`)}`;
}

/** An email address trimmed and lowercased, as custom forms normalizes it. Undefined when it isn't one. */
export function klaviyoNormalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > EMAIL_MAX * 2) return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX && EMAIL.test(email) ? email : undefined;
}

/** A phone number as its digits, as custom forms normalizes it. Undefined with fewer than seven digits or more than fifteen. */
export function klaviyoNormalizePhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : undefined;
}

/** The contact reference for one normalized detail: the same string custom forms makes for it. */
export function klaviyoContactRef(key: string, kind: "email" | "phone", normalized: string): string {
  return `${CONTACT_REF_PREFIX}${mac(key, `${kind}:${normalized}`)}`;
}

/** Contact references for a profile's email address and phone number, email first as custom forms orders them. */
export function klaviyoContactRefs(key: string, contact: { email?: unknown; phone?: unknown }): string[] {
  const email = klaviyoNormalizeEmail(contact.email);
  const phone = klaviyoNormalizePhone(contact.phone);
  return [...(email ? [klaviyoContactRef(key, "email", email)] : []), ...(phone ? [klaviyoContactRef(key, "phone", phone)] : [])];
}
