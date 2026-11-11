import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads products, customers, suppliers, sales, purchases and stock by location with an API application's account id and key. Cin7 Core's docs describe no way to limit what an application can do, so the client only ever sends GETs of the six lists. The first client's account confirms the mock built from Cin7 Core's docs",
  capabilities: [
    "Imports every product, customer and supplier and five years of sales and purchases, then what changed on each sync",
    "Shows stock on hand, allocated, available and on order for each product at each location, bin and batch",
    "Reads sales and purchases with what is paid and still owed, the same way as the store and books connectors",
    "Never keeps a customer's or supplier's address, contact, phone number or email address",
    "Read-only: KaratOS never changes stock or posts an order in Cin7 Core",
  ],
  settings: ["CIN7_ACCOUNT_ID", "CIN7_APPLICATION_KEY"],
} satisfies ConnectorCatalogEntry;
