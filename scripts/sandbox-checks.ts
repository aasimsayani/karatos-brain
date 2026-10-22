import { randomBytes } from "node:crypto";
import type { SandboxCheck } from "@karatos/core";
import { memoryTokenStore, quickBooksConnector, shopifyConnector, squareConnector, stripeConnector, xeroConnector } from "@karatos/connectors";

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
    // A Square developer account's sandbox seller, connected to the app over OAuth with the read scopes only.
    // Always the sandbox host. Square keeps the same refresh token, so the secret doesn't need updating after a run.
    // Each run makes its own customer reference key, as nothing it stores is kept.
    integration: "square",
    name: "Square",
    credentials: ["SANDBOX_SQUARE_APPLICATION_ID", "SANDBOX_SQUARE_APPLICATION_SECRET", "SANDBOX_SQUARE_REFRESH_TOKEN"],
    connector: (c) =>
      squareConnector({
        environment: "sandbox",
        applicationId: c.SANDBOX_SQUARE_APPLICATION_ID!,
        applicationSecret: c.SANDBOX_SQUARE_APPLICATION_SECRET!,
        refreshToken: c.SANDBOX_SQUARE_REFRESH_TOKEN!,
        customerKey: randomBytes(32).toString("hex"),
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
