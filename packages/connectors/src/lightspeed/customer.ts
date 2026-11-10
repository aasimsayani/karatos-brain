import { createHmac } from "node:crypto";
import { checkSquareCustomerKey } from "../square/customer.js";
import { LIGHTSPEED_ID } from "./client.js";

/**
 * A Lightspeed customer becomes a keyed reference, never a name, email
 * address, phone number, birthday or address, and never Lightspeed's own
 * customer ID either. The reference is an HMAC-SHA256 of the ID keyed with
 * the instance's CUSTOMER_REF_KEY, the key Square and the custom forms use:
 * one customer's sales and profile link up, but nobody holding the events
 * can look the customer up in Lightspeed without the key.
 */

export const LIGHTSPEED_CUSTOMER_PREFIX = "lightspeed:customer:";

/** Throws unless CUSTOMER_REF_KEY is long enough to be a secret. */
export const checkLightspeedCustomerKey = checkSquareCustomerKey;

/** The reference for one Lightspeed customer ID, or undefined when there is no usable ID. */
export function lightspeedCustomerRef(key: string, id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const value = id.trim().toLowerCase();
  if (!LIGHTSPEED_ID.test(value)) return undefined;
  const mac = createHmac("sha256", checkSquareCustomerKey(key)).update(`lightspeed_customer:${value}`, "utf8").digest("hex");
  return `${LIGHTSPEED_CUSTOMER_PREFIX}${mac.slice(0, 32)}`;
}
