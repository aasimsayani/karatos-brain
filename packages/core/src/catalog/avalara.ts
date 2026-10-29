import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only by allowlist: an AvaTax license key can do anything the account can, so the client sends only its three listed reads, with filters it builds itself. No public AvaTax changelog; the nightly sandbox run catches API changes",
  settings: ["AVALARA_ACCOUNT_ID", "AVALARA_LICENSE_KEY", "AVALARA_ENVIRONMENT", "CUSTOMER_REF_KEY"],
  capabilities: [
    "Imports five years of sales tax for every sale, return and purchase, then keeps it current as transactions are committed, voided or adjusted",
    "Finance and compliance see the tax charged by state, county, city and special district, with each rate and taxable and exempt amount",
    "Shows which sales were tax exempt and why, such as resale, without keeping the exemption certificate number",
    "Links a transaction to the same customer's other records without keeping their name, email address or address",
    "Read-only: KaratOS never records, commits, voids or adjusts anything in AvaTax",
  ],
} satisfies ConnectorCatalogEntry;
