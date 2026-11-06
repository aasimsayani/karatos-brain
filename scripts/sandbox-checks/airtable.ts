import type { SandboxCheck } from "@karatos/core";
import { airtableConnector } from "@karatos/connectors";

// A free Airtable workspace for testing, with a base or two of synthetic records, and a personal access token with only data.records:read and schema.bases:read.
export default {
  integration: "airtable",
  name: "Airtable",
  credentials: ["SANDBOX_AIRTABLE_ACCESS_TOKEN"],
  connector: (c) => airtableConnector({ token: c.SANDBOX_AIRTABLE_ACCESS_TOKEN! }),
} satisfies SandboxCheck;
