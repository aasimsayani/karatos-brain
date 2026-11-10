import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads calls and texts with the workspace's Quo API key. Quo keys have full access, so the client only ever sends List calls and List messages. No sandbox: the first client's key confirms the mock built from Quo's docs",
  capabilities: [
    "Imports two years of calls and texts on every Quo line, then rereads the last day on each sync",
    "Shows who called or wrote, whether a call was missed, how long it ran and when each text was delivered",
    "Links each caller to the same customer as forms, Klaviyo and AvaTax, without keeping the number",
    "Keeps no message text, recordings, transcripts, voicemails or call summaries",
    "Read-only: KaratOS never sends a text or changes a Quo contact",
  ],
  settings: ["QUO_API_KEY", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
