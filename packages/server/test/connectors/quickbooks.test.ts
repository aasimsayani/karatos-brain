import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { QUICKBOOKS_TEST_REALM, qbVendor, quickBooksDocMock } from "@karatos/connector-testkit";
import { REFRESH_TOKEN_STREAM, StaticDocumentationSource, scheduledConnectors } from "../../src/index.js";
import { ORG, buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// Test-only values, assembled at runtime.
const SECRET = ["client", "secret", "0".repeat(20)].join("-");
const SEED = ["RT", "TEST", "0"].join("-");
const sealed = (memory: InMemoryStore) => memory.getCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the QuickBooks factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("quickbooks", { QUICKBOOKS_CLIENT_ID: "id", QUICKBOOKS_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REALM_ID, QUICKBOOKS_ENVIRONMENT");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the app's keys, the company and a refresh token", async () => {
    await buildsFromSettings("quickbooks", {
      QUICKBOOKS_CLIENT_ID: "client-id",
      QUICKBOOKS_CLIENT_SECRET: "client-secret-value",
      QUICKBOOKS_REALM_ID: "9341450000",
      QUICKBOOKS_REFRESH_TOKEN: "refresh-value",
      QUICKBOOKS_ENVIRONMENT: "sandbox",
    });
  });
});

describe("QuickBooks on a schedule", () => {
  it("keeps each rotated refresh token in the database, so the next round and a restart keep working", async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const vendors = qbVendor.many(2).map((v) => ({ ...v, MetaData: { ...v.MetaData, LastUpdatedTime: recent } }));
    const mock = quickBooksDocMock({ entities: { Vendor: vendors }, refreshToken: SEED, now: () => new Date() });
    vi.stubGlobal("fetch", mock.fetch);
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const env = {
      QUICKBOOKS_CLIENT_ID: "client-id",
      QUICKBOOKS_CLIENT_SECRET: SECRET,
      QUICKBOOKS_REALM_ID: QUICKBOOKS_TEST_REALM,
      QUICKBOOKS_REFRESH_TOKEN: SEED,
      QUICKBOOKS_ENVIRONMENT: "sandbox",
    };
    const round = async () => {
      // Each round, like a restart, builds the connector afresh from the same settings.
      const [scheduled] = scheduledConnectors(["quickbooks"], env, { memory, organizationId: ORG }).connectors;
      return runSync({ connector: await scheduled!.make(), mode: "incremental", pipeline, memory, organizationId: ORG });
    };
    expect((await round()).ingested).toBe(2);
    // The second round reads only what changed since the first began, with a token the first one stored.
    expect(await round()).toMatchObject({ ingested: 0, deadLettered: 0 });
    expect(mock.refreshes).toBe(2);
    expect(mock.refreshToken).toBe("RT-TEST-2");
    expect(await sealed(memory)).not.toContain("RT-TEST");
  });
});
