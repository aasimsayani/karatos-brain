import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const fakeHubSpotToken = () => ["pat", "na1", ["00000000", "0000", "4000", "8000", "000000000000"].join("-")].join("-");

describe("the HubSpot factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("hubspot", { HUBSPOT_ACCESS_TOKEN: " " });
    expect(reason).toBe("missing HUBSPOT_ACCESS_TOKEN");
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("hubspot", {
      HUBSPOT_ACCESS_TOKEN: fakeHubSpotToken(),
    });
  });
});
