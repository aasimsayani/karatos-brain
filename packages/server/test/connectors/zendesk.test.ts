import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { ZENDESK_TEST_SUBDOMAIN, zendeskDocMock, zendeskTicket } from "@karatos/connector-testkit";
import { REFRESH_TOKEN_STREAM, StaticDocumentationSource, scheduledConnectors } from "../../src/index.js";
import { ORG, buildsFromSettings, skipReason } from "../connector-harness.js";

// Test-only values, assembled at runtime.
const SECRET = ["zs", "secret", "0".repeat(20)].join("-");
const SEED = ["ZR", "TEST", "0"].join("-");
const SETTINGS = { ZENDESK_SUBDOMAIN: ZENDESK_TEST_SUBDOMAIN, ZENDESK_CLIENT_ID: "karatos_test", ZENDESK_CLIENT_SECRET: SECRET, ZENDESK_REFRESH_TOKEN: SEED, CUSTOMER_REF_KEY: "c".repeat(64) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Zendesk factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("zendesk", {})).toBe("missing ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET, ZENDESK_REFRESH_TOKEN, CUSTOMER_REF_KEY");
    const { ZENDESK_REFRESH_TOKEN: _, ...rest } = SETTINGS;
    expect(skipReason("zendesk", rest)).toBe("missing ZENDESK_REFRESH_TOKEN");
    expect(skipReason("zendesk", rest)).not.toContain(SECRET);
    expect(skipReason("zendesk", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("zendesk", SETTINGS);
    await expect(buildsFromSettings("zendesk", { ...SETTINGS, ZENDESK_SUBDOMAIN: "store.zendesk.com" })).rejects.toThrow(/ZENDESK_SUBDOMAIN/);
    await expect(buildsFromSettings("zendesk", { ...SETTINGS, ZENDESK_CLIENT_ID: "x" })).rejects.toThrow(/ZENDESK_CLIENT_ID/);
    await expect(buildsFromSettings("zendesk", { ...SETTINGS, ZENDESK_CLIENT_SECRET: "short" })).rejects.toThrow(/ZENDESK_CLIENT_SECRET/);
    await expect(buildsFromSettings("zendesk", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow(/CUSTOMER_REF_KEY/);
  });
});

describe("Zendesk on a schedule", () => {
  it("keeps each rotated refresh token in the database, so the next round and a restart keep working", async () => {
    zendeskTicket.reset();
    const recent = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const mock = zendeskDocMock({ clientId: SETTINGS.ZENDESK_CLIENT_ID, clientSecret: SECRET, refreshToken: SEED, tickets: zendeskTicket.many(2).map((t) => ({ ...t, updated_at: recent })), users: [] });
    vi.stubGlobal("fetch", mock.fetch);
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const round = async () => {
      // Each round, like a restart, builds the connector afresh from the same settings.
      const [scheduled] = scheduledConnectors(["zendesk"], SETTINGS, { memory, organizationId: ORG }).connectors;
      return runSync({ connector: await scheduled!.make(), mode: "incremental", pipeline, memory, organizationId: ORG });
    };
    expect((await round()).ingested).toBe(2);
    // The second round goes on from the first's cursors, with the refresh token the first one stored.
    expect(await round()).toMatchObject({ ingested: 0, deadLettered: 0 });
    expect(mock.refreshes).toBe(2);
    expect(mock.refreshToken).toBe("zd-refresh-2");
    const sealed = await memory.getCheckpoint(ORG, "zendesk", REFRESH_TOKEN_STREAM);
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain("zd-refresh");
  });
});
