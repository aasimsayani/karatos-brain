import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  webhooks: false,
  note: "Reads supplier bills, approvals, vendors and payments from BILL's v3 API with a developer app made for accounting data only. BILL has no read-only option, so the connector only ever reads. BILL's sandbox checks the sign-in and calls, and the docs watch follows the pages the mock is built from",
  capabilities: [
    "Imports six years of supplier bills with their due dates, balances, payment status and approval status",
    "Imports the vendors the store pays, and every payment with the bills it paid",
    "Keeps every change once, so a bill moving from unpaid to scheduled to paid is on the record",
    "Leaves out vendor email addresses, phone numbers, street addresses, tax ids, bank and account numbers, card digits and memos",
    "Read-only: KaratOS never pays, approves or changes anything in BILL, and its sign-in leaves out payments and funding accounts",
  ],
  settings: ["BILL_CLIENT_ID", "BILL_CLIENT_SECRET"],
} satisfies ConnectorCatalogEntry;
