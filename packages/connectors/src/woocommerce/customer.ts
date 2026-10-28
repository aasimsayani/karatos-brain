import { createHmac } from "node:crypto";

/**
 * A WooCommerce customer becomes a keyed reference, never a name, email
 * address, phone number or address, and never WooCommerce's own customer ID
 * either. The reference is an HMAC-SHA256 of the store's hostname and the
 * customer's ID, keyed with the instance's CUSTOMER_REF_KEY (the key custom
 * forms, Square and Clover use for theirs): one customer's orders and
 * profile link up, but nobody holding the events can look the customer up
 * in the store without the key, and two stores never share references.
 *
 * Changing the key breaks every link already made, so it is never rotated.
 */

export const WOOCOMMERCE_CUSTOMER_PREFIX = "woocommerce:customer:";
const MIN_KEY_LENGTH = 32;

export class WooCommerceCustomerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WooCommerceCustomerKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkWooCommerceCustomerKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new WooCommerceCustomerKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

/** The reference for one customer of one store, or undefined for a guest (ID 0) or anything that isn't an ID. */
export function wooCommerceCustomerRef(key: string, storeHost: string, id: unknown): string | undefined {
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d{1,15}$/.test(id) ? Number(id) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  const mac = createHmac("sha256", checkWooCommerceCustomerKey(key)).update(`woocommerce:customer:v1:${storeHost}:${n}`, "utf8").digest("hex");
  return `${WOOCOMMERCE_CUSTOMER_PREFIX}${mac.slice(0, 32)}`;
}
