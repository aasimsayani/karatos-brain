import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@karatos/core";
import { sealedTokenStore } from "../../src/index.js";
import { ORG, buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = {
  LIGHTSPEED_DOMAIN_PREFIX: "teststore",
  LIGHTSPEED_CLIENT_ID: "client-id-value",
  LIGHTSPEED_CLIENT_SECRET: "client-secret-value",
  LIGHTSPEED_REFRESH_TOKEN: "refresh-value",
  CUSTOMER_REF_KEY: "k".repeat(64),
};

describe("the Lightspeed factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("lightspeed", { LIGHTSPEED_CLIENT_SECRET: secret, LIGHTSPEED_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing LIGHTSPEED_DOMAIN_PREFIX, LIGHTSPEED_CLIENT_ID, CUSTOMER_REF_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the store's prefix, the app's keys, a refresh token and the customer key", async () => {
    await buildsFromSettings("lightspeed", SETTINGS);
  });

  it("keeps each new refresh token sealed in the instance's database, keyed by the client secret", async () => {
    const memory = new InMemoryStore();
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? String(url));
      if (String(url).endsWith("/api/1.0/token")) {
        return new Response(JSON.stringify({ access_token: "test-access-token-1", expires_in: 3600, refresh_token: "refresh-value-2", scope: "products:read" }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    });
    try {
      const connector = await buildsFromSettings("lightspeed", SETTINGS, { memory, organizationId: ORG });
      await expect(connector.historicalImport({ organizationId: ORG, cursor: null })[Symbol.asyncIterator]().next()).rejects.toThrow("HTTP 500");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent[0]).toBe("refresh-value");
    const stored = sealedTokenStore({ memory, organizationId: ORG, source: "lightspeed", seed: "refresh-value", keyMaterial: "client-secret-value" });
    expect(await stored.load()).toBe("refresh-value-2");
    expect(JSON.stringify(memory)).not.toContain("refresh-value-2");
  });
});
