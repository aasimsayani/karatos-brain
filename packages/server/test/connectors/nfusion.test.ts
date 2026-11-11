import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["nf", "test", "x".repeat(20)].join("_");

describe("the nFusion factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("nfusion", {})).toBe("missing NFUSION_TOKEN");
    expect(skipReason("nfusion", { NFUSION_TOKEN: "  " })).toBe("missing NFUSION_TOKEN");
    expect(skipReason("nfusion", { NFUSION_TOKEN: TOKEN })).toBeNull();
  });

  it("builds the connector from its setting", async () => {
    const connector = await buildsFromSettings("nfusion", { NFUSION_TOKEN: ` ${TOKEN} ` });
    expect(connector.source).toBe("nfusion");
    expect(connector.writes).toEqual([]);
  });

  it("won't build with a token that can't be an nFusion token, and doesn't echo it", async () => {
    const wrong = `${fakeKey("sk", "live")}&x=1`;
    const error = await buildsFromSettings("nfusion", { NFUSION_TOKEN: wrong }).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe("set NFUSION_TOKEN to the API token from the nFusion dashboard (Connections, then API Keys): 8 to 256 letters, digits, _ or -");
    expect(error?.message).not.toContain(wrong);
  });
});
