import { createHmac } from "node:crypto";

/**
 * A BigCommerce customer becomes a keyed reference, never a name, email
 * address, phone number, address or IP address, and never BigCommerce's own
 * customer ID either. The reference is an HMAC-SHA256 of the store hash and
 * the customer ID, keyed with the instance's CUSTOMER_REF_KEY, the same key
 * custom form submissions and the Square and Clover connectors use: one
 * customer's orders and profile link up, but nobody holding the events can
 * look the customer up in the store without the key. BigCommerce customer
 * IDs are small numbers counted per store, so the store hash keeps two
 * stores' customers apart.
 *
 * Changing the key breaks every link already made, so it is never rotated.
 */

export const BIGCOMMERCE_CUSTOMER_PREFIX = "bigcommerce:customer:";
const MIN_KEY_LENGTH = 32;
const CUSTOMER_ID = /^[1-9]\d{0,11}$/;

export class BigCommerceCustomerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigCommerceCustomerKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkBigCommerceCustomerKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new BigCommerceCustomerKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

/** The reference for one customer of one store, or undefined for a guest (ID 0) or anything that isn't an ID. */
export function bigCommerceCustomerRef(key: string, storeHash: string, id: unknown): string | undefined {
  const text = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" && id.length <= 12 ? id : "";
  if (!CUSTOMER_ID.test(text)) return undefined;
  const mac = createHmac("sha256", checkBigCommerceCustomerKey(key)).update(`bigcommerce_customer:${storeHash}:${text}`, "utf8").digest("hex");
  return `${BIGCOMMERCE_CUSTOMER_PREFIX}${mac.slice(0, 32)}`;
}
