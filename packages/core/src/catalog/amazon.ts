import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  webhooks: false,
  note: "Connects through a private SP-API app the seller authorizes with the Finance and Accounting, and Amazon Fulfillment, roles. Its only API requests are three GETs (orders, transactions and FBA stock) and the Login with Amazon token refresh, and it never asks for the buyer or the address. Listings, returns and settlement reports are a follow-up. Amazon sends notifications through AWS queues rather than signed webhooks, so there is no webhook to verify",
  settings: ["AMAZON_SP_CLIENT_ID", "AMAZON_SP_CLIENT_SECRET", "AMAZON_SP_REFRESH_TOKEN", "AMAZON_SP_MARKETPLACE_ID", "AMAZON_SP_REGION", "AMAZON_SP_ENVIRONMENT"],
  capabilities: [
    "Imports two years of Amazon orders with their status, totals and lines, counted as sales next to the store and website",
    "Reads every sale, fee, refund and transfer Amazon posts to the seller's account, with its breakdown and the order it belongs to",
    "Counts each SKU's stock in Amazon's warehouses: ready to ship, inbound, reserved and unsellable",
    "Never asks Amazon for the buyer's name or address",
    "Changing a listing's quantity or price is declared but turned off, and would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
