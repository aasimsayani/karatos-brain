import { describe, expect, it } from "vitest";
import { scheduledConnectors } from "../../src/index.js";
import { buildsFromSettings } from "../connector-harness.js";

describe("the Shopify factory", () => {
  it("accepts either Shopify sign-in and lists both client settings when neither is set", () => {
    const client = scheduledConnectors(["shopify"], { SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com", SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret" });
    expect(client.connectors.map((c) => c.id)).toEqual(["shopify"]);
    const half = scheduledConnectors(["shopify"], { SHOPIFY_CLIENT_ID: "id-value" });
    expect(half.skipped).toEqual([{ id: "shopify", reason: "missing SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET" }]);
  });

  it("builds the connector from the client credentials or an admin token", async () => {
    await buildsFromSettings("shopify", { SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com", SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret", SHOPIFY_API_VERSION: "2026-07" });
    await buildsFromSettings("shopify", { SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "t" });
  });
});
