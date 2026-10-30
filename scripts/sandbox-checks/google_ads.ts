import type { SandboxCheck } from "@karatos/core";
import { googleAdsConnector, memoryTokenStore } from "@karatos/connectors";

// A Google Ads test manager account with a test client account under it, and a Google account made for testing that
// can sign in to the manager, connected to a test OAuth client with the adwords scope. Any developer token reads test
// accounts, so the run needs no approved token. A consent screen in Testing gives refresh tokens that expire after 7
// days, so when the run fails with invalid_grant, reconnect the test account and update the secret.
export default {
  integration: "google_ads",
  name: "Google Ads",
  credentials: [
    "SANDBOX_GOOGLE_ADS_CLIENT_ID",
    "SANDBOX_GOOGLE_ADS_CLIENT_SECRET",
    "SANDBOX_GOOGLE_ADS_REFRESH_TOKEN",
    "SANDBOX_GOOGLE_ADS_DEVELOPER_TOKEN",
    "SANDBOX_GOOGLE_ADS_CUSTOMER_ID",
    "SANDBOX_GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  ],
  connector: (c) =>
    googleAdsConnector({
      clientId: c.SANDBOX_GOOGLE_ADS_CLIENT_ID!,
      clientSecret: c.SANDBOX_GOOGLE_ADS_CLIENT_SECRET!,
      developerToken: c.SANDBOX_GOOGLE_ADS_DEVELOPER_TOKEN!,
      customerId: c.SANDBOX_GOOGLE_ADS_CUSTOMER_ID!,
      loginCustomerId: c.SANDBOX_GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
      tokens: memoryTokenStore(c.SANDBOX_GOOGLE_ADS_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
