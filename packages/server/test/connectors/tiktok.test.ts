import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@karatos/core";
import { REFRESH_TOKEN_STREAM } from "../../src/index.js";
import { ORG, buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { TIKTOK_CLIENT_KEY: `aw${"k".repeat(14)}`, TIKTOK_CLIENT_SECRET: "s".repeat(32), TIKTOK_REFRESH_TOKEN: `rft.${"r".repeat(60)}` };

describe("the TikTok factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("tiktok", { TIKTOK_CLIENT_KEY: "aw1", TIKTOK_CLIENT_SECRET: secret })).toBe("missing TIKTOK_REFRESH_TOKEN");
    expect(skipReason("tiktok", { TIKTOK_REFRESH_TOKEN: secret })).toBe("missing TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET");
    expect(skipReason("tiktok", { TIKTOK_CLIENT_KEY: "aw1", TIKTOK_CLIENT_SECRET: secret })).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("tiktok", SETTINGS);
  });

  it("won't build without the app's client key and secret", async () => {
    await expect(buildsFromSettings("tiktok", { ...SETTINGS, TIKTOK_CLIENT_KEY: "has space" })).rejects.toThrow("set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
  });

  it("keeps the refresh token TikTok replaces sealed in the instance's database, under its own source", async () => {
    const memory = new InMemoryStore();
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "AT", expires_in: 86400, refresh_token: `rft.${"n".repeat(60)}`, scope: "user.info.basic,user.info.stats,video.list" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "invalid_params", message: "stop" } }), { status: 400 });
    });
    try {
      const connector = await buildsFromSettings("tiktok", SETTINGS, { memory, organizationId: ORG });
      await connector.historicalImport({ organizationId: ORG, cursor: null })[Symbol.asyncIterator]().next().catch(() => {});
    } finally {
      vi.unstubAllGlobals();
    }
    const sealed = await memory.getCheckpoint(ORG, "tiktok", REFRESH_TOKEN_STREAM);
    expect(sealed).toEqual(expect.any(String));
    expect(sealed).not.toContain("nnnn");
  });
});
