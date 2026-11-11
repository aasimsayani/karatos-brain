import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads one extension's calls, texts and voicemail with a JWT credential, under an app given only ReadCallLog and ReadMessages; the client stops if the token can do more. RingCentral's developer sandbox needs a paid account, so the first client's credential confirms the mock built from RingCentral's guide",
  capabilities: [
    "Imports two years of calls, texts and voicemail on the store's RingCentral line, then rereads the last day on each sync",
    "Shows who called or wrote, whether a call was missed, how long it ran, and whether a text or voicemail was read",
    "Links each caller to the same customer as Quo, forms, Klaviyo and AvaTax, without keeping the number",
    "Keeps no message text, voicemail audio, transcripts, recordings or caller names",
    "Read-only: KaratOS never sends a text or places a call",
  ],
  settings: ["RINGCENTRAL_CLIENT_ID", "RINGCENTRAL_CLIENT_SECRET", "RINGCENTRAL_JWT", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
