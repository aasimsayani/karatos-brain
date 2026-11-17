import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only, though an Afterpay Merchant ID and Secret Key can't be limited to reading: the connector only sends GET requests to List Payments. Sandbox credentials come from an Afterpay account manager",
  capabilities: [
    "Imports five years of Afterpay orders and refunds, then keeps the last 60 days current as orders are captured, refunded or voided",
    "Sales sees each pay-over-time order's amount and state, matched to the store's own order number",
    "Finance sees what was captured and refunded on each order, in whole cents",
    "Keeps no shopper names, emails, phone numbers, addresses or items",
    "Read-only: KaratOS only reads your Afterpay account and never captures, refunds or voids an order",
  ],
  settings: ["AFTERPAY_MERCHANT_ID", "AFTERPAY_SECRET_KEY", "AFTERPAY_ENVIRONMENT"],
} satisfies ConnectorCatalogEntry;
