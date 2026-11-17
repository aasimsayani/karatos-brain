import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["wth", "x".repeat(32)].join("_");

describe("the WatchTraderHub factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("watchtraderhub", {})).toBe("missing WATCHTRADERHUB_API_KEY");
    expect(skipReason("watchtraderhub", { WATCHTRADERHUB_API_KEY: "  " })).toBe("missing WATCHTRADERHUB_API_KEY");
    expect(skipReason("watchtraderhub", { WATCHTRADERHUB_API_KEY: KEY })).toBeNull();
  });

  it("builds the connector from its setting", async () => {
    const connector = await buildsFromSettings("watchtraderhub", { WATCHTRADERHUB_API_KEY: ` ${KEY} ` });
    expect(connector.source).toBe("watchtraderhub");
  });

  it("won't build with a key that isn't a WatchTraderHub API key, and doesn't echo it", async () => {
    const wrong = fakeKey("sk", "live");
    const error = await buildsFromSettings("watchtraderhub", { WATCHTRADERHUB_API_KEY: wrong }).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe("set WATCHTRADERHUB_API_KEY to a WatchTraderHub API key, which is wth_ and 32 letters and digits");
    expect(error?.message).not.toContain(wrong);
  });
});
