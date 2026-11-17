import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  note: "Reads with a Flute API key (Aurora Payments renamed itself Flute). A merchant's own key can reach every endpoint, so the client only ever asks for a token and lists settlement batches and their transactions. The vendor docs watch follows Flute's changelog, and a nightly run against Flute's sandbox checks the connector",
  capabilities: [
    "Imports five years of card and ACH settlement batches, each with its transactions, then each new or settled batch",
    "Matches each deposit to its batch's sales, refunds and net, and each transaction's tax, tip and surcharge",
    "Keeps no customer name, email, phone or card digits",
    "Read-only: KaratOS never refunds or voids a transaction",
  ],
  settings: ["AURORA_CLIENT_ID", "AURORA_CLIENT_SECRET", "AURORA_ENVIRONMENT"],
} satisfies ConnectorCatalogEntry;
