import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connector in @karatos/connectors: charges, refunds, disputes, payouts, balance transactions and customers, read-only",
  capabilities: [
    "Imports five years of charges, refunds, disputes and payouts, then keeps them current from Stripe's events",
    "Finance sees every fee and payout, so card income can be matched to bank deposits",
    "Sales sees each payment's method and status, and every refund and dispute",
    "Read-only: KaratOS signs in with a restricted key that can't move money",
  ],
} satisfies ConnectorCatalogEntry;
