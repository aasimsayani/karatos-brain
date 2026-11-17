import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// Test values assembled at runtime, so no scanner mistakes the source for a leak.
const PASSWORD = ["app", "pass", "x".repeat(12)].join("-");
const KEY = "c".repeat(32);
const SETTINGS = { IMAP_HOST: "imap.example.test", IMAP_USERNAME: "store@example.test", IMAP_PASSWORD: PASSWORD, CORRESPONDENT_HASH_KEY: KEY };

describe("the IMAP factory", () => {
  it("names each setting it is missing, never a value", () => {
    expect(skipReason("imap_email", {})).toBe("missing IMAP_HOST, IMAP_USERNAME, IMAP_PASSWORD, CORRESPONDENT_HASH_KEY");
    expect(skipReason("imap_email", { ...SETTINGS, IMAP_PASSWORD: "  " })).toBe("missing IMAP_PASSWORD");
    expect(skipReason("imap_email", { ...SETTINGS, CORRESPONDENT_HASH_KEY: "" })).toBe("missing CORRESPONDENT_HASH_KEY");
    // The port is optional.
    expect(skipReason("imap_email", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with or without a port", async () => {
    expect((await buildsFromSettings("imap_email", { ...SETTINGS, IMAP_HOST: " imap.example.test " })).source).toBe("imap_email");
    expect((await buildsFromSettings("imap_email", { ...SETTINGS, IMAP_PORT: " 1993 " })).writes?.map((w) => w.name)).toEqual(["draft_reply", "flag_message"]);
    expect((await buildsFromSettings("imap_email", { ...SETTINGS, IMAP_PORT: "" })).source).toBe("imap_email");
  });

  it("won't build with a setting that doesn't read, and doesn't echo it", async () => {
    const wrong = fakeKey("sk", "live");
    const fail = (env: Record<string, string>) => buildsFromSettings("imap_email", env).then(() => null, (e: unknown) => e as Error);
    const host = await fail({ ...SETTINGS, IMAP_HOST: `imaps://${wrong}.example.test` });
    expect(host?.message).toBe("set IMAP_HOST to the IMAP server's host name, such as imap.example.com, without imaps:// or a port");
    expect(host?.message).not.toContain(wrong);
    expect((await fail({ ...SETTINGS, IMAP_PORT: "143x" }))?.message).toBe("IMAP_PORT must be a whole number from 1 to 65535; leave it empty for 993, IMAP over TLS");
    expect((await fail({ ...SETTINGS, IMAP_PORT: "70000" }))?.message).toContain("IMAP_PORT");
    const key = await fail({ ...SETTINGS, CORRESPONDENT_HASH_KEY: "short" });
    expect(key?.message).toContain("CORRESPONDENT_HASH_KEY");
  });
});
