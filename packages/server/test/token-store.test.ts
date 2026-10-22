import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { GMAIL_MOCK_LABELS, QUICKBOOKS_TEST_REALM, gmailDocMock, gmailMessage, qbVendor, quickBooksDocMock } from "@karatos/connector-testkit";
import { REFRESH_TOKEN_STREAM, StaticDocumentationSource, scheduledConnectors, sealedTokenStore } from "../src/index.js";

const ORG = "test-jeweler";
// Test-only values, assembled at runtime.
const SECRET = ["client", "secret", "0".repeat(20)].join("-");
const SEED = ["RT", "TEST", "0"].join("-");
const store = (memory = new InMemoryStore(), overrides: Partial<Parameters<typeof sealedTokenStore>[0]> = {}) =>
  sealedTokenStore({ memory, organizationId: ORG, source: "quickbooks", seed: SEED, keyMaterial: SECRET, ...overrides });
const sealed = (memory: InMemoryStore) => memory.getCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sealedTokenStore", () => {
  it("starts from the seed, then returns the newest saved token, kept encrypted", async () => {
    const memory = new InMemoryStore();
    const tokens = store(memory);
    expect(await tokens.load()).toBe(SEED);
    await tokens.save("RT-TEST-41");
    expect(await tokens.load()).toBe("RT-TEST-41");
    expect(await store(memory).load()).toBe("RT-TEST-41");
    const raw = (await sealed(memory))!;
    expect(raw).not.toContain("RT-TEST-41");
    expect(raw).not.toContain(SEED);
    expect(Object.keys(JSON.parse(raw))).toEqual(["v", "seed", "iv", "tag", "data"]);
    // A fresh IV every time: sealing the same token twice gives different rows.
    await tokens.save("RT-TEST-41");
    expect(await sealed(memory)).not.toBe(raw);
  });

  it("goes back to the seed when it is replaced, the client secret rotates, or the row is tampered with", async () => {
    const memory = new InMemoryStore();
    await store(memory).save("RT-TEST-41");
    expect(await store(memory, { seed: "RT-TEST-NEW" }).load()).toBe("RT-TEST-NEW");
    expect(await store(memory, { keyMaterial: `${SECRET}x` }).load()).toBe(SEED);
    expect(await store(memory, { organizationId: "other-store" }).load()).toBe(SEED);
    const row = JSON.parse((await sealed(memory))!) as { data: string };
    const flipped = Buffer.from(row.data, "base64");
    flipped[0] = flipped[0]! ^ 1;
    await memory.saveCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM, JSON.stringify({ ...row, data: flipped.toString("base64") }));
    expect(await store(memory).load()).toBe(SEED);
    for (const junk of ["not json", JSON.stringify({ v: 2 }), "null"]) {
      await memory.saveCheckpoint(ORG, "quickbooks", REFRESH_TOKEN_STREAM, junk);
      expect(await store(memory).load()).toBe(SEED);
    }
  });

  it("needs a seed and enough key material, and ignores an empty token", async () => {
    expect(() => store(undefined, { seed: " " })).toThrow("a refresh token store needs a seed token");
    expect(() => store(undefined, { keyMaterial: "short" })).toThrow("a refresh token store needs the client secret to derive its key");
    const memory = new InMemoryStore();
    await store(memory).save("  ");
    expect(await sealed(memory)).toBeNull();
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

describe("Gmail on a schedule", () => {
  it("refreshes with the seed token every round, since Google doesn't rotate it, and stores nothing it didn't get", async () => {
    gmailMessage.reset();
    const recent = String(Date.now() - 3_600_000);
    const mock = gmailDocMock({ messages: gmailMessage.many(2).map((m) => ({ ...m, internalDate: recent })), labels: GMAIL_MOCK_LABELS, refreshToken: SEED });
    vi.stubGlobal("fetch", mock.fetch);
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const env = { GOOGLE_CLIENT_ID: "000000000000-test.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: SECRET, GMAIL_REFRESH_TOKEN: SEED, CORRESPONDENT_HASH_KEY: "0".repeat(64) };
    const round = async () => {
      const [scheduled] = scheduledConnectors(["gmail"], env, { memory, organizationId: ORG }).connectors;
      return runSync({ connector: await scheduled!.make(), mode: "incremental", pipeline, memory, organizationId: ORG, sleep: async () => {} });
    };
    expect((await round()).ingested).toBe(GMAIL_MOCK_LABELS.length + 2);
    expect(mock.refreshes).toBe(1);
    expect(await memory.getCheckpoint(ORG, "gmail", REFRESH_TOKEN_STREAM)).toBeNull();
  });
});
