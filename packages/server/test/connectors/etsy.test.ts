import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@karatos/core";
import { sealedTokenStore } from "../../src/index.js";
import { ORG, buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { ETSY_KEYSTRING: "k".repeat(24), ETSY_SHARED_SECRET: "s".repeat(10), ETSY_REFRESH_TOKEN: "70000001.refresh", ETSY_SHOP_ID: "50000001" };

describe("the Etsy factory", () => {
  it("names the settings it is missing, never a value", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("etsy", { ETSY_REFRESH_TOKEN: secret })).toBe("missing ETSY_KEYSTRING, ETSY_SHARED_SECRET, ETSY_SHOP_ID");
    expect(skipReason("etsy", { ETSY_REFRESH_TOKEN: secret })).not.toContain(secret);
    const { ETSY_SHOP_ID: _shop, ...noShop } = SETTINGS;
    expect(skipReason("etsy", noShop)).toBe("missing ETSY_SHOP_ID");
    expect(skipReason("etsy", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("etsy", SETTINGS);
  });

  it("won't build with a key or shop id in the wrong shape", async () => {
    await expect(buildsFromSettings("etsy", { ...SETTINGS, ETSY_KEYSTRING: "short" })).rejects.toThrow("set ETSY_KEYSTRING and ETSY_SHARED_SECRET");
    await expect(buildsFromSettings("etsy", { ...SETTINGS, ETSY_SHOP_ID: "my-shop" })).rejects.toThrow("ETSY_SHOP_ID must be the shop's numeric id");
  });

  it("keeps each new refresh token sealed in the instance's database, keyed by the app's keystring and shared secret", async () => {
    const memory = new InMemoryStore();
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? String(url));
      if (String(url).endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "70000001.test-access-1", expires_in: 3600, refresh_token: "70000001.refresh-2" }), { status: 200 });
      return new Response("{}", { status: 500 });
    });
    try {
      const connector = await buildsFromSettings("etsy", SETTINGS, { memory, organizationId: ORG });
      await expect(connector.historicalImport({ organizationId: ORG, cursor: null })[Symbol.asyncIterator]().next()).rejects.toThrow("Etsy did not say which scopes the connection has (HTTP 500)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent[0]).toBe("70000001.refresh");
    const stored = sealedTokenStore({ memory, organizationId: ORG, source: "etsy", seed: "70000001.refresh", keyMaterial: `${"k".repeat(24)}:${"s".repeat(10)}` });
    expect(await stored.load()).toBe("70000001.refresh-2");
    expect(JSON.stringify(memory)).not.toContain("refresh-2");
  });
});
