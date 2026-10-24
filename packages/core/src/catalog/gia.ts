import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  note: "Looks up each certificate number on the business's list once, then follows GIA's free changed-reports feed. GIA's free plan includes a sandbox key; lookups of reports the business didn't submit cost per lookup. The docs watch follows the API changelog, and the nightly sandbox run catches API changes",
  capabilities: [
    "Confirms each GIA certificate number the business holds, with shape, carat weight, color, clarity, cut and proportions",
    "Tells natural diamonds, laboratory-grown diamonds, pearls and colored stones apart by report type",
    "Flags a certificate number GIA has no report for, so it can be checked before the piece is sold or insured",
    "Keeps every report current through GIA's changed-reports feed, without paying for a second lookup",
    "Read-only: KaratOS only reads reports and never changes anything at GIA",
  ],
  settings: ["GIA_API_URL", "GIA_API_KEY", "GIA_REPORT_NUMBERS_FILE"],
  changelog: "https://gialaboratory.github.io/report-results/changelog",
} satisfies ConnectorCatalogEntry;
