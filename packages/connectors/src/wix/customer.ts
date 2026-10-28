import { createHmac } from "node:crypto";

/**
 * A Wix contact becomes a keyed reference, never a name, email address,
 * phone number or address, and never Wix's own contact ID either. The
 * reference is an HMAC-SHA256 of the app instance (one per site) and the
 * contact's ID, keyed with the instance's CUSTOMER_REF_KEY, the same key
 * custom form submissions and the Square, Clover, WooCommerce and
 * BigCommerce connectors use: one customer's orders and profile link up, but
 * nobody holding the events can look the customer up in Wix without the
 * key, and two sites never share references.
 *
 * Changing the key breaks every link already made, so it is never rotated.
 */

export const WIX_CUSTOMER_PREFIX = "wix:customer:";
const MIN_KEY_LENGTH = 32;
/** Wix contact IDs are GUIDs. */
const CONTACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class WixCustomerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WixCustomerKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkWixCustomerKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new WixCustomerKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

/** The reference for one contact of one site, or undefined for anything that isn't a contact ID. */
export function wixCustomerRef(key: string, instanceId: string, id: unknown): string | undefined {
  const text = typeof id === "string" && id.length <= 36 ? id.toLowerCase() : "";
  if (!CONTACT_ID.test(text)) return undefined;
  const mac = createHmac("sha256", checkWixCustomerKey(key)).update(`wix:contact:v1:${instanceId}:${text}`, "utf8").digest("hex");
  return `${WIX_CUSTOMER_PREFIX}${mac.slice(0, 32)}`;
}
