import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only, though an Authorize.net key can't be limited to reading: the connector sends Transaction Reporting requests only. The docs watch follows the API changelog, and the nightly sandbox run catches API changes",
  capabilities: [
    "Imports five years of settlement batches and the card and eCheck transactions in them, then keeps them current",
    "Finance sees what each batch settled to the bank, charges less refunds, so deposits can be matched",
    "Sales sees each payment's status, card brand and channel, and every refund, void and chargeback",
    "Keeps the card brand only: no card numbers, names, emails, addresses or customer IP addresses",
    "Read-only: KaratOS only reads your reports and never charges, refunds or voids anything",
  ],
  settings: [
    "AUTHORIZE_NET_API_LOGIN_ID",
    "AUTHORIZE_NET_TRANSACTION_KEY",
    "AUTHORIZE_NET_ENVIRONMENT",
  ],
} satisfies ConnectorCatalogEntry;
