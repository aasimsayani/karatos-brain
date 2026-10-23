import type { SandboxCheck } from "@karatos/core";
import { bigCommerceConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free BigCommerce sandbox store and a store-level API account holding read-only scopes only.
// The token doesn't expire or rotate. Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "bigcommerce",
  name: "BigCommerce",
  credentials: ["SANDBOX_BIGCOMMERCE_STORE_HASH", "SANDBOX_BIGCOMMERCE_ACCESS_TOKEN"],
  connector: (c) =>
    bigCommerceConnector({ storeHash: c.SANDBOX_BIGCOMMERCE_STORE_HASH!, accessToken: c.SANDBOX_BIGCOMMERCE_ACCESS_TOKEN!, customerKey: randomBytes(32).toString("hex") }),
} satisfies SandboxCheck;
