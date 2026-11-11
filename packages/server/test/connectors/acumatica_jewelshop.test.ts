import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = {
  ACUMATICA_URL: "https://jewelshop.example.test",
  ACUMATICA_CLIENT_ID: "00000000-0000-4000-8000-000000000001@Company",
  ACUMATICA_CLIENT_SECRET: ["s", "a".repeat(20)].join(""),
  ACUMATICA_USERNAME: "karatos",
  ACUMATICA_PASSWORD: ["p", "b".repeat(20)].join(""),
  CUSTOMER_REF_KEY: "k".repeat(64),
};

describe("the Acumatica JewelShop factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const { ACUMATICA_PASSWORD: _p, ...noPassword } = SETTINGS;
    expect(skipReason("acumatica_jewelshop", { ...noPassword, ACUMATICA_CLIENT_SECRET: secret })).toBe("missing ACUMATICA_PASSWORD");
    expect(skipReason("acumatica_jewelshop", { ...noPassword, ACUMATICA_CLIENT_SECRET: secret })).not.toContain(secret);
    const { CUSTOMER_REF_KEY: _k, ...noKey } = SETTINGS;
    expect(skipReason("acumatica_jewelshop", noKey)).toBe("missing CUSTOMER_REF_KEY");
  });

  it("builds the connector from its settings, with or without an endpoint version", async () => {
    await buildsFromSettings("acumatica_jewelshop", SETTINGS);
    await buildsFromSettings("acumatica_jewelshop", { ...SETTINGS, ACUMATICA_ENDPOINT_VERSION: "25.200.001" });
  });

  it("won't build for an address that isn't https or a version it doesn't know", async () => {
    await expect(buildsFromSettings("acumatica_jewelshop", { ...SETTINGS, ACUMATICA_URL: "http://jewelshop.example.test" })).rejects.toThrow("ACUMATICA_URL must be the instance's https address");
    await expect(buildsFromSettings("acumatica_jewelshop", { ...SETTINGS, ACUMATICA_ENDPOINT_VERSION: "20.200.001" })).rejects.toThrow("ACUMATICA_ENDPOINT_VERSION must be one of");
  });
});
