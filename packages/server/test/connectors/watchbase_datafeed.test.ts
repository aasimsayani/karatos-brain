import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["test", "k".repeat(24)].join("");

describe("the WatchBase Data Feed factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("watchbase_datafeed", {})).toBe("missing WATCHBASE_API_KEY, WATCHBASE_BRANDS");
    expect(skipReason("watchbase_datafeed", { WATCHBASE_API_KEY: KEY })).toBe("missing WATCHBASE_BRANDS");
    expect(skipReason("watchbase_datafeed", { WATCHBASE_API_KEY: "  ", WATCHBASE_BRANDS: "37" })).toBe("missing WATCHBASE_API_KEY");
    expect(skipReason("watchbase_datafeed", { WATCHBASE_API_KEY: KEY, WATCHBASE_BRANDS: "37" })).toBeNull();
  });

  it("builds the connector from its settings, with WATCHBASE_MAX_WATCHES optional", async () => {
    expect((await buildsFromSettings("watchbase_datafeed", { WATCHBASE_API_KEY: ` ${KEY} `, WATCHBASE_BRANDS: "37, Testmaker" })).source).toBe("watchbase_datafeed");
    expect((await buildsFromSettings("watchbase_datafeed", { WATCHBASE_API_KEY: KEY, WATCHBASE_BRANDS: "37", WATCHBASE_MAX_WATCHES: " 50 " })).source).toBe("watchbase_datafeed");
  });

  it("won't build with a key, brand list or cap that doesn't read, and doesn't echo the key", async () => {
    const wrong = `${fakeKey("sk", "live")}&x`;
    const fail = (env: Record<string, string>) => buildsFromSettings("watchbase_datafeed", env).then(() => null, (e: unknown) => e as Error);
    const error = await fail({ WATCHBASE_API_KEY: wrong, WATCHBASE_BRANDS: "37" });
    expect(error?.message).toBe("set WATCHBASE_API_KEY to the API key of a WatchBase datafeed account: 16 to 128 letters, digits, _ or -");
    expect(error?.message).not.toContain(wrong);
    expect((await fail({ WATCHBASE_API_KEY: KEY, WATCHBASE_BRANDS: "0" }))?.message).toBe("WATCHBASE_BRANDS has a BrandID that isn't a whole number from 1 to 999999999");
    expect((await fail({ WATCHBASE_API_KEY: KEY, WATCHBASE_BRANDS: "37", WATCHBASE_MAX_WATCHES: "10001" }))?.message).toBe("WATCHBASE_MAX_WATCHES must be a whole number from 1 to 10000");
  });
});
