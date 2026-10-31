import { inventoryPosSource } from "./inventory-pos.js";
import { metalsSource } from "./metals.js";
import { plaidSource } from "./plaid.js";
import { quickBooksSource } from "./quickbooks.js";
import type { DemoSource } from "./source.js";
import { twilioSource } from "./twilio.js";
import { watchSearchSource } from "./watchsearch.js";

export * from "./inventory-pos.js";
export * from "./metals.js";
export * from "./plaid.js";
export * from "./quickbooks.js";
export * from "./source.js";
export * from "./twilio.js";
export * from "./watchsearch.js";

/** Every system the demo store runs on, in the order they sync. */
export const DEMO_SOURCES: readonly DemoSource[] = [metalsSource, inventoryPosSource, plaidSource, quickBooksSource, twilioSource, watchSearchSource];

const sameJobAs = (what: string) => `Does the same job as ${what}, which the demo store already runs on`;
const NOT_READ_YET = "Its records don't reach a department yet, so they wouldn't show on the dashboard";
const NEXT = "Joins the demo store in its next update";

/**
 * Built connectors the demo store doesn't run on yet, and why. A test
 * checks every built connector is either a demo source or listed here, so
 * a new connector can't be left out of the demo by accident.
 */
export const DEMO_NOT_YET: Readonly<Record<string, string>> = {
  shopify: sameJobAs("the POS exports"),
  square: sameJobAs("the POS exports"),
  clover: sameJobAs("the POS exports"),
  woocommerce: NEXT,
  bigcommerce: sameJobAs("the POS exports"),
  wix: sameJobAs("the POS exports"),
  xero: sameJobAs("QuickBooks"),
  chase: sameJobAs("Plaid"),
  bank_statements: sameJobAs("Plaid"),
  klaviyo: NEXT,
  gmail: NEXT,
  slack: NEXT,
  hubspot: NEXT,
  stripe: NEXT,
  refiner_statements: NEXT,
  piro: NEXT,
  pinterest: NEXT,
  affirm: NOT_READ_YET,
  authorize_net: NOT_READ_YET,
  avalara: NOT_READ_YET,
  calendly: NOT_READ_YET,
  custom_forms: NOT_READ_YET,
  edi_x12: NOT_READ_YET,
  gia: NOT_READ_YET,
  google_workspace: NOT_READ_YET,
  idex: NOT_READ_YET,
  monday: NOT_READ_YET,
  nivoda: NOT_READ_YET,
  rapnet: NOT_READ_YET,
  stuller: NOT_READ_YET,
};
