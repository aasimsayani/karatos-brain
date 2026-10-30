import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the app holds only the payrolls:read scope, and after every token refresh the connector asks Gusto what the token may do and stops on any other scope or another company. Webhook deliveries only prompt a sync",
  settings: ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "GUSTO_REDIRECT_URI", "GUSTO_COMPANY_UUID", "GUSTO_REFRESH_TOKEN"],
  capabilities: [
    "Imports three years of processed payrolls with their gross pay, taxes, benefits and company debit",
    "Shows what each employee was paid in each payroll, with hours, overtime, commissions and bonuses",
    "Tells regular payrolls from off-cycle bonus or correction runs",
    "Flags a regular payroll that costs far more than the ones before it, so it gets a second look",
    "Names employees by Gusto's id only, never keeping names, pay rates, bank details or tax withholdings",
    "Read-only: KaratOS never creates, changes or runs a payroll in Gusto",
  ],
} satisfies ConnectorCatalogEntry;
