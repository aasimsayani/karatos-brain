import { describe, expect, it, vi } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { SQUARESPACE_API_KEY: ["sq", "a".repeat(30)].join(""), CUSTOMER_REF_KEY: "k".repeat(64) };

describe("the Squarespace factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("squarespace", { CUSTOMER_REF_KEY: secret })).toBe("missing SQUARESPACE_API_KEY");
    expect(skipReason("squarespace", { CUSTOMER_REF_KEY: secret })).not.toContain(secret);
    expect(skipReason("squarespace", { SQUARESPACE_API_KEY: secret })).toBe("missing CUSTOMER_REF_KEY");
    expect(skipReason("squarespace", {})).toBe("missing SQUARESPACE_API_KEY, CUSTOMER_REF_KEY");
    expect(skipReason("squarespace", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a key in the wrong shape", async () => {
    await buildsFromSettings("squarespace", SETTINGS);
    await expect(buildsFromSettings("squarespace", { ...SETTINGS, SQUARESPACE_API_KEY: "short" })).rejects.toThrow("SQUARESPACE_API_KEY is missing or not in the expected shape");
  });

  it("sends the key it is given", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string>).authorization ?? "");
      return new Response("{}", { status: 401 });
    });
    try {
      const connector = await buildsFromSettings("squarespace", SETTINGS);
      await expect(connector.historicalImport({ organizationId: "test", cursor: null })[Symbol.asyncIterator]().next()).rejects.toThrow("turned down SQUARESPACE_API_KEY (HTTP 401)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([`Bearer ${SETTINGS.SQUARESPACE_API_KEY}`]);
  });
});
