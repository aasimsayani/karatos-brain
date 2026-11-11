import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads shipments and labels with the account's API key. ShipStation has no read-only key: the key could also buy and void labels, so the client only ever sends GETs of the two lists. API access depends on the plan: the first client's account confirms the mock built from ShipStation's docs",
  capabilities: [
    "Imports two years of shipments and labels, then the shipments changed since the last sync and the last 30 days of labels on each sync",
    "Shows each parcel's insured value next to what the customer paid, so an underinsured parcel stands out",
    "Tracks each label until it is delivered, with its carrier, service, signature and costs, the same way as UPS tracking",
    "Never keeps a name, street address, phone number, email address or buyer note",
    "Read-only: KaratOS never buys or voids a label",
  ],
  settings: ["SHIPSTATION_API_KEY"],
} satisfies ConnectorCatalogEntry;
