import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["wn", "pat", "tk", "x".repeat(20)].join("_");

describe("the Whatnot factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("whatnot", {})).toBe("missing WHATNOT_ACCESS_TOKEN");
    expect(skipReason("whatnot", { WHATNOT_ACCESS_TOKEN: "  " })).toBe("missing WHATNOT_ACCESS_TOKEN");
    expect(skipReason("whatnot", { WHATNOT_ACCESS_TOKEN: TOKEN })).toBeNull();
  });

  it("builds the connector from its setting", async () => {
    const connector = await buildsFromSettings("whatnot", { WHATNOT_ACCESS_TOKEN: ` ${TOKEN} ` });
    expect(connector.source).toBe("whatnot");
  });

  it("won't build with a token that isn't a Whatnot seller API token, and doesn't echo it", async () => {
    const wrong = fakeKey("sk", "live");
    const error = await buildsFromSettings("whatnot", { WHATNOT_ACCESS_TOKEN: wrong }).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe("set WHATNOT_ACCESS_TOKEN to a Whatnot seller API token, which starts wn_pat_tk_ or wn_access_tk_");
    expect(error?.message).not.toContain(wrong);
  });
});
