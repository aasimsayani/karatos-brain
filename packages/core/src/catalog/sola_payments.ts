import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  note: "Reads the gateway's transaction report with one API key. Sola's keys can't be limited to reports, so the client only ever posts Report:All to the reporting address, never the gateway. Sola publishes no API changelog, so the vendor docs watch follows its reporting page and the nightly sandbox run catches changes; until a sandbox is set up, the mock built from Sola's docs stands in",
  capabilities: [
    "Imports five years of card and check payments and refunds, then the last two days again on each sync",
    "Shows each payment's amount, card brand, approval, void and batch, the same way as Stripe and Authorize.net payments",
    "Links payments to the customer's orders and layaway by a keyed reference, never a name, card or email address",
    "Read-only: KaratOS never charges a card, refunds a payment or sets up a schedule",
  ],
  settings: ["SOLA_API_KEY", "SOLA_TIME_ZONE", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
