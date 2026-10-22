import type { SandboxCheck } from "@karatos/core";
import { cloverConnector, memoryTokenStore, plaidConnector, quickBooksConnector, shopifyConnector, stripeConnector, xeroConnector } from "@karatos/connectors";

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
    // A Clover developer account's test merchant on the sandbox, with a merchant API token made in its dashboard
    // holding the Read permissions only. Always the sandbox host. The token doesn't rotate, so the run keeps working.
    // The customer key only has to be stable for the run; sandbox customers are synthetic.
    integration: "clover",
    name: "Clover",
    credentials: ["SANDBOX_CLOVER_MERCHANT_ID", "SANDBOX_CLOVER_API_TOKEN", "SANDBOX_CLOVER_CUSTOMER_REF_KEY"],
    connector: (c) =>
      cloverConnector({
        merchantId: c.SANDBOX_CLOVER_MERCHANT_ID!,
        region: "sandbox",
        auth: { apiToken: c.SANDBOX_CLOVER_API_TOKEN! },
        customerKey: c.SANDBOX_CLOVER_CUSTOMER_REF_KEY!,
      }),
  },
  {
    // A Plaid Sandbox Item, linked to one of Plaid's test banks with the transactions product only.
    // Always the sandbox host, whatever the token, and the client refuses a token that names production.
    integration: "plaid",
    name: "Plaid",
    credentials: ["SANDBOX_PLAID_CLIENT_ID", "SANDBOX_PLAID_SECRET", "SANDBOX_PLAID_ACCESS_TOKEN"],
    connector: (c) =>
      plaidConnector({
        clientId: c.SANDBOX_PLAID_CLIENT_ID!,
        secret: c.SANDBOX_PLAID_SECRET!,
        accessToken: c.SANDBOX_PLAID_ACCESS_TOKEN!,
        environment: "sandbox",
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
