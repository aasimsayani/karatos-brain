import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only, though an Affirm key pair can't be limited to reading: the connector only sends GET requests for transactions, disputes and settlements. US accounts only for now. The docs watch follows the API changelog, and the nightly sandbox run catches API changes",
  capabilities: [
    "Imports five years of Affirm financed orders, refunds, disputes and daily settlements, then keeps them current",
    "Sales sees each financed order's status, from authorized to captured, refunded or voided, matched to the store's order number",
    "Finance sees what Affirm deposited each day, sales less refunds and fees, under the deposit ID on the bank statement",
    "Keeps no shopper names, emails, phone numbers or addresses",
    "Read-only: KaratOS only reads your Affirm account and never captures, refunds or voids a loan",
  ],
  settings: ["AFFIRM_PUBLIC_API_KEY", "AFFIRM_PRIVATE_API_KEY", "AFFIRM_MERCHANT_ID", "AFFIRM_ENVIRONMENT"],
} satisfies ConnectorCatalogEntry;
