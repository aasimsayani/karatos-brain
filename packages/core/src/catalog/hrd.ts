import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "public_api",
  testWith: "fixtures",
  note: "Looks up each HRD report number on the business's list once through the public MyHRD API, then checks each night that the reports are still valid. HRD issues a token on request through MyHRD, free of charge as far as its docs say. HRD publishes no API changelog, so the docs watch follows the API guide",
  capabilities: [
    "Confirms each HRD Antwerp report number the business holds, with shape, carat weight, color, clarity, cut, polish, symmetry and proportions",
    "Reads jewellery reports too: the piece's type, metal, diamond count and total carat weight",
    "Flags a report number HRD has no report for, and a report HRD no longer lists as valid, so it can be checked before the piece is sold or insured",
    "Looks a report up again when HRD reissues it",
    "Read-only: KaratOS only reads reports and never changes anything at HRD",
  ],
  settings: ["HRD_API_TOKEN", "HRD_REPORT_NUMBERS_FILE"],
} satisfies ConnectorCatalogEntry;
