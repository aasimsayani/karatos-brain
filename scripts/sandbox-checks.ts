import type { SandboxCheck } from "@karatos/core";
import { randomBytes } from "node:crypto";
import { customFormsConnector, memoryTokenStore, quickBooksConnector, shopifyConnector, stripeConnector } from "@karatos/connectors";

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
    // A free Typeform account with one test form filled in with made-up answers, and a personal token holding
    // forms:read and responses:read only. Each run makes its own customer reference key, as nothing it stores is kept.
    integration: "custom_forms",
    name: "Custom forms (Typeform)",
    credentials: ["SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN", "SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID"],
    connector: (c) =>
      customFormsConnector({
        forms: [c.SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID!],
        customerKey: randomBytes(32).toString("hex"),
        typeform: { accessToken: c.SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN! },
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
