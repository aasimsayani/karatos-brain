import type { SandboxCheck } from "@karatos/core";
import { wooCommerceConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A WooCommerce test store on a public https address (a staging site or a free test host), with a Read key.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "woocommerce",
  name: "WooCommerce",
  credentials: ["SANDBOX_WOOCOMMERCE_STORE_URL", "SANDBOX_WOOCOMMERCE_CONSUMER_KEY", "SANDBOX_WOOCOMMERCE_CONSUMER_SECRET"],
  connector: (c) =>
    wooCommerceConnector({
      storeUrl: c.SANDBOX_WOOCOMMERCE_STORE_URL!,
      consumerKey: c.SANDBOX_WOOCOMMERCE_CONSUMER_KEY!,
      consumerSecret: c.SANDBOX_WOOCOMMERCE_CONSUMER_SECRET!,
      customerKey: randomBytes(32).toString("hex"),
    }),
} satisfies SandboxCheck;
