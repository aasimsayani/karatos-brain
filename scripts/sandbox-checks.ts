import type { SandboxCheck } from "@karatos/core";
import { shopifyConnector, stripeConnector } from "@karatos/connectors";

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
