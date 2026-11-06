import type { SandboxCheck } from "@karatos/core";
import { googleAnalyticsConnector, memoryTokenStore } from "@karatos/connectors";

// A Google account made for testing, with Viewer access to Google's public GA4 demo account (the Google Merchandise
// Store), connected to a test OAuth client with analytics.readonly only. A consent screen in Testing gives refresh
// tokens that expire after 7 days, so when the run fails with invalid_grant, reconnect the test account and update
// the secret.
export default {
  integration: "google_analytics",
  name: "Google Analytics 4",
  credentials: ["SANDBOX_GOOGLE_ANALYTICS_CLIENT_ID", "SANDBOX_GOOGLE_ANALYTICS_CLIENT_SECRET", "SANDBOX_GOOGLE_ANALYTICS_REFRESH_TOKEN", "SANDBOX_GOOGLE_ANALYTICS_PROPERTY_ID"],
  connector: (c) =>
    googleAnalyticsConnector({
      clientId: c.SANDBOX_GOOGLE_ANALYTICS_CLIENT_ID!,
      clientSecret: c.SANDBOX_GOOGLE_ANALYTICS_CLIENT_SECRET!,
      propertyId: c.SANDBOX_GOOGLE_ANALYTICS_PROPERTY_ID!,
      tokens: memoryTokenStore(c.SANDBOX_GOOGLE_ANALYTICS_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
