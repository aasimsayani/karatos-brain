import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Typeform forms through its Responses API, and signed submissions from any other form or website. Keeps only the mapped request details, never contact details or the customer's own words",
  capabilities: [
    "Imports five years of appointment requests, repair intake and custom order requests from Typeform, then keeps them current",
    "Takes signed submissions from your own website form or any form tool that can sign them",
    "Sorts each submission into appointment, repair or custom order requests with the date, piece, metal, stone and budget asked for",
    "Links a customer's requests together without keeping their email address or phone number",
    "Never keeps names, contact details, descriptions in the customer's own words or uploaded photos",
    "Read-only: KaratOS only reads your forms' responses and never changes a form",
  ],
  testWith: "sandbox",
  settings: ["CUSTOMER_REF_KEY"],
  signIn: [
    ["TYPEFORM_ACCESS_TOKEN", "TYPEFORM_FORM_IDS"],
    ["WEBHOOK_SIGNING_SECRET"],
  ],
} satisfies ConnectorCatalogEntry;
