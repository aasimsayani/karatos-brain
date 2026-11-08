import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only by its client: Docusign has no read-only scope, so it signs in with JWT Grant as a user that can't send envelopes, and sends only the sign-in, the user's accounts and envelope reads. It never downloads a document. Connect deliveries are verified with the configuration's HMAC keys",
  webhooks: true,
  settings: ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_USER_ID", "DOCUSIGN_ACCOUNT_ID", "DOCUSIGN_PRIVATE_KEY", "DOCUSIGN_ENVIRONMENT", "DOCUSIGN_CONNECT_HMAC_KEYS", "CUSTOMER_REF_KEY"],
  capabilities: [
    "Imports five years of agreements sent for signature, such as consignment and memo agreements, then keeps them current",
    "Shows each agreement's status and when it was sent, viewed, signed, declined, completed or voided",
    "Knows who has yet to sign each agreement out for signature, so unsigned ones can be chased",
    "Links an agreement to the same person's other records without keeping their name or email address",
    "Never keeps email subjects, messages, decline reasons or what was typed into a field, and never downloads a document",
    "Read-only: KaratOS never sends, voids or changes anything in Docusign",
  ],
} satisfies ConnectorCatalogEntry;
