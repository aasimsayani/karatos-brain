import { createHmac } from "node:crypto";

/**
 * A Square customer becomes a keyed reference, never a name, email address,
 * phone number or address, and never Square's own customer ID either. The
 * reference is an HMAC-SHA256 of the ID keyed with the instance's
 * CUSTOMER_REF_KEY, the same key custom form submissions use for customer
 * references: one customer's sales, payments and profile link up, but
 * nobody holding the events can look the customer up in Square without the
 * key, and two instances never share references.
 *
 * Changing the key breaks every link already made, so it is never rotated.
 */

export const SQUARE_CUSTOMER_PREFIX = "square:customer:";
const MIN_KEY_LENGTH = 32;
/** Square's customer IDs: letters, digits, dashes and underscores, at most 191 characters. */
const CUSTOMER_ID = /^[A-Za-z0-9_-]+$/;

export class SquareCustomerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquareCustomerKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkSquareCustomerKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new SquareCustomerKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

/** The reference for one Square customer ID, or undefined when there is no usable ID. */
export function squareCustomerRef(key: string, id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0 || id.length > 191 || !CUSTOMER_ID.test(id)) return undefined;
  const mac = createHmac("sha256", checkSquareCustomerKey(key)).update(`square_customer:${id}`, "utf8").digest("hex");
  return `${SQUARE_CUSTOMER_PREFIX}${mac.slice(0, 32)}`;
}
