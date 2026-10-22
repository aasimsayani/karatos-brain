import type { SandboxCheck } from "@karatos/core";
import { randomBytes } from "node:crypto";
import { googleWorkspaceConnector, memoryTokenStore, parseSheetRanges, quickBooksConnector, shopifyConnector, stripeConnector, xeroConnector } from "@karatos/connectors";

/**
 * Every built connector registers a sandbox check here. Credentials are
 * test-only sandbox values, named SANDBOX_<INTEGRATION>_<WHAT>, stored as
 * GitHub Actions secrets and listed in .github/workflows/sandbox-run.yml.
 * Never point a check at a client's account.
 */
export const SANDBOX_CHECKS: SandboxCheck[] = [
  {
    // A free Shopify development store and a Dev Dashboard app in the same organization, holding read scopes only.
    integration: "shopify",
    name: "Shopify",
    credentials: ["SANDBOX_SHOPIFY_SHOP_DOMAIN", "SANDBOX_SHOPIFY_CLIENT_ID", "SANDBOX_SHOPIFY_CLIENT_SECRET"],
    connector: (c) =>
      shopifyConnector({ shopDomain: c.SANDBOX_SHOPIFY_SHOP_DOMAIN!, clientId: c.SANDBOX_SHOPIFY_CLIENT_ID!, clientSecret: c.SANDBOX_SHOPIFY_CLIENT_SECRET! }),
  },
  {
    // A Stripe account in test mode, with a restricted key holding read permissions only.
    integration: "stripe",
    name: "Stripe",
    credentials: ["SANDBOX_STRIPE_SECRET_KEY"],
    connector: (c) => stripeConnector({ secretKey: c.SANDBOX_STRIPE_SECRET_KEY! }),
  },
  {
    // An Intuit developer sandbox company and the app's Development keys. Always the sandbox API, whatever the token.
    // The run can't save the token Intuit rotates to, so it keeps working only while the stored one does;
    // when the run fails with invalid_grant, reconnect the sandbox company and update the secret.
    integration: "quickbooks",
    name: "QuickBooks Online",
    credentials: ["SANDBOX_QUICKBOOKS_CLIENT_ID", "SANDBOX_QUICKBOOKS_CLIENT_SECRET", "SANDBOX_QUICKBOOKS_REALM_ID", "SANDBOX_QUICKBOOKS_REFRESH_TOKEN"],
    connector: (c) =>
      quickBooksConnector({
        clientId: c.SANDBOX_QUICKBOOKS_CLIENT_ID!,
        clientSecret: c.SANDBOX_QUICKBOOKS_CLIENT_SECRET!,
        realmId: c.SANDBOX_QUICKBOOKS_REALM_ID!,
        environment: "sandbox",
        tokens: memoryTokenStore(c.SANDBOX_QUICKBOOKS_REFRESH_TOKEN!),
      }),
  },
  {
    // A Google account made for testing, holding only a synthetic folder, spreadsheet and calendar, connected to a test
    // OAuth client with drive.metadata.readonly, spreadsheets.readonly and calendar.events.readonly only. Google has no
    // Workspace sandbox. A consent screen in Testing gives refresh tokens that expire after 7 days, so when the run fails
    // with invalid_grant, reconnect the test account and update the secret. The correspondent key is new each run.
    integration: "google_workspace",
    name: "Google Workspace and Drive",
    credentials: ["SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID", "SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET", "SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN", "SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID", "SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE"],
    connector: (c) =>
      googleWorkspaceConnector({
        clientId: c.SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID!,
        clientSecret: c.SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET!,
        rootFolderId: c.SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID!,
        sheets: parseSheetRanges(c.SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE),
        calendarIds: ["primary"],
        correspondentKey: randomBytes(32).toString("hex"),
        tokens: memoryTokenStore(c.SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN!),
      }),
  },
  {
    // Xero's Demo Company, connected to a test app with the read-only scopes. Xero has no separate sandbox API:
    // the Demo Company is a throwaway organisation on the real API that Xero resets every 28 days.
    // Xero retires the refresh token on each refresh and the run can't save the new one, so the secret needs
    // updating after every run; until a way to store it exists, expect this check to fail with invalid_grant.
    integration: "xero",
    name: "Xero",
    credentials: ["SANDBOX_XERO_CLIENT_ID", "SANDBOX_XERO_CLIENT_SECRET", "SANDBOX_XERO_TENANT_ID", "SANDBOX_XERO_REFRESH_TOKEN"],
    connector: (c) =>
      xeroConnector({
        clientId: c.SANDBOX_XERO_CLIENT_ID!,
        clientSecret: c.SANDBOX_XERO_CLIENT_SECRET!,
        tenantId: c.SANDBOX_XERO_TENANT_ID!,
        tokens: memoryTokenStore(c.SANDBOX_XERO_REFRESH_TOKEN!),
      }),
  },
];

/** Problems that would make the nightly run skip a check by mistake or touch a non-sandbox secret. */
export function credentialProblems(checks: readonly SandboxCheck[], workflow: string): string[] {
  const problems: string[] = [];
  for (const check of checks) {
    for (const name of check.credentials) {
      const prefix = `SANDBOX_${check.integration.toUpperCase()}_`;
      if (!name.startsWith(prefix) || !/^[A-Z0-9_]+$/.test(name)) {
        problems.push(`${check.integration}: credential ${name} must be named ${prefix}<WHAT>`);
      }
      if (!workflow.includes(`${name}: \${{ secrets.${name} }}`)) {
        problems.push(`${check.integration}: ${name} isn't passed to the job in sandbox-run.yml`);
      }
    }
  }
  return problems;
}
