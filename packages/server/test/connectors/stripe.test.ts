import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Stripe factory", () => {
  it("needs a secret key", () => {
    expect(skipReason("stripe", { STRIPE_SECRET_KEY: "   " })).toBe("missing STRIPE_SECRET_KEY");
  });

  it("builds the connector from a restricted key and a pinned version", async () => {
    await buildsFromSettings("stripe", { STRIPE_SECRET_KEY: fakeKey("rk", "test"), STRIPE_API_VERSION: "2026-09-30.clover" });
  });
});
