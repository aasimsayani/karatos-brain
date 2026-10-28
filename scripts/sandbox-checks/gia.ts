import type { SandboxCheck } from "@karatos/core";
import { giaConnector } from "@karatos/connectors";

// A GIA sandbox key from the free plan, never a client's key. It can only read GIA's published sandbox reports.
export const GIA_SANDBOX_REPORTS = ["2141438169", "2141438171", "5202397873", "2141438189", "AN384"];

export default {
  integration: "gia",
  name: "GIA Report Results",
  credentials: ["SANDBOX_GIA_API_URL", "SANDBOX_GIA_API_KEY"],
  connector: (c) =>
    giaConnector({
      apiUrl: c.SANDBOX_GIA_API_URL!,
      apiKey: c.SANDBOX_GIA_API_KEY!,
      reportNumbers: async () => GIA_SANDBOX_REPORTS,
      maxLookups: GIA_SANDBOX_REPORTS.length,
    }),
} satisfies SandboxCheck;
