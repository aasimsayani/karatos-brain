import type { SandboxCheck } from "@karatos/core";
import { shopifyConnector } from "@karatos/connectors";

// A free Shopify development store and a Dev Dashboard app in the same organization, holding read scopes only.
export default {
  integration: "shopify",
  name: "Shopify",
  credentials: ["SANDBOX_SHOPIFY_SHOP_DOMAIN", "SANDBOX_SHOPIFY_CLIENT_ID", "SANDBOX_SHOPIFY_CLIENT_SECRET"],
  connector: (c) =>
    shopifyConnector({ shopDomain: c.SANDBOX_SHOPIFY_SHOP_DOMAIN!, clientId: c.SANDBOX_SHOPIFY_CLIENT_ID!, clientSecret: c.SANDBOX_SHOPIFY_CLIENT_SECRET! }),
} satisfies SandboxCheck;
