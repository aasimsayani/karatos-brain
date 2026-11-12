import { describe, expect, it } from "vitest";
import type { MetaConnector } from "@karatos/connectors";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["EAA", "test", "x".repeat(30)].join("");
const SECRET = ["ab", "cd"].join("").repeat(8);
const ENV = {
  META_PAGE_ID: "1000000001",
  META_PAGE_ACCESS_TOKEN: TOKEN,
  META_INSTAGRAM_ACCOUNT_ID: "1780000001",
  META_APP_SECRET: SECRET,
  WHATSAPP_VERIFY_TOKEN: "v".repeat(24),
  WHATSAPP_PHONE_NUMBER_ID: "1060000001",
  CUSTOMER_REF_KEY: "c".repeat(64),
};
const without = (...names: string[]) => Object.fromEntries(Object.entries(ENV).filter(([k]) => !names.includes(k)));

describe("the Meta factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("meta", {})).toBe("missing META_PAGE_ID, META_PAGE_ACCESS_TOKEN, META_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, CUSTOMER_REF_KEY, META_INSTAGRAM_ACCOUNT_ID");
    expect(skipReason("meta", { ...ENV, META_PAGE_ACCESS_TOKEN: "  " })).toBe("missing META_PAGE_ACCESS_TOKEN");
    expect(skipReason("meta", ENV)).toBeNull();
    // The Instagram account is needed only while Instagram is on.
    expect(skipReason("meta", without("META_INSTAGRAM_ACCOUNT_ID"))).toBe("missing META_INSTAGRAM_ACCOUNT_ID");
    expect(skipReason("meta", { ...without("META_INSTAGRAM_ACCOUNT_ID"), META_CHANNELS: "instagram" })).toBe("missing META_INSTAGRAM_ACCOUNT_ID");
    expect(skipReason("meta", { ...without("META_INSTAGRAM_ACCOUNT_ID"), META_CHANNELS: "messenger" })).toBeNull();
    // Channels that don't read are named when the connector is built.
    expect(skipReason("meta", { ...without("META_INSTAGRAM_ACCOUNT_ID"), META_CHANNELS: "fax" })).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    const connector = (await buildsFromSettings("meta", { ...ENV, META_PAGE_ID: ` ${ENV.META_PAGE_ID} ` })) as MetaConnector;
    expect(connector.webhookChallenge({ "hub.mode": "subscribe", "hub.challenge": "7", "hub.verify_token": ENV.WHATSAPP_VERIFY_TOKEN })).toBe("7");
    expect((await buildsFromSettings("meta", { ...without("META_INSTAGRAM_ACCOUNT_ID"), META_CHANNELS: "messenger" })).source).toBe("meta");
  });

  it("won't build with settings that don't read, and doesn't echo them", async () => {
    const wrong = fakeKey("sk", "live");
    const error = await buildsFromSettings("meta", { ...ENV, META_APP_SECRET: wrong }).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe("set META_APP_SECRET to the Meta app's secret, 32 hex characters");
    expect(error?.message).not.toContain(wrong);
    const channels = await buildsFromSettings("meta", { ...ENV, META_CHANNELS: "fax" }).then(() => null, (e: unknown) => e as Error);
    expect(channels?.message).toBe("META_CHANNELS must be messenger, instagram or both, separated by a comma");
  });
});
