import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { CLOVER_TEST_APP, CLOVER_TEST_MERCHANT, cloverDocMock, cloverItem, notCardLike } from "@karatos/connector-testkit";
import { REFRESH_TOKEN_STREAM, StaticDocumentationSource, scheduledConnectors } from "../../src/index.js";

const ORG = "test-jeweler";
// Test-only values, assembled at runtime.
const SECRET = ["client", "secret", "0".repeat(20)].join("-");
const SEED = ["RT", "TEST", "0"].join("-");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Clover on a schedule", () => {
  it("keeps each rotated refresh token in the database, sealed with the app secret", async () => {
    const recent = notCardLike(Date.now() - 3_600_000);
    cloverItem.reset();
    const mock = cloverDocMock({ records: { items: cloverItem.many(2).map((i) => ({ ...i, modifiedTime: recent })) }, refreshToken: SEED, now: () => Date.now() });
    vi.stubGlobal("fetch", mock.fetch);
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const env = {
      CLOVER_MERCHANT_ID: CLOVER_TEST_MERCHANT,
      CLOVER_REGION: "sandbox",
      CLOVER_APP_ID: CLOVER_TEST_APP,
      CLOVER_APP_SECRET: SECRET,
      CLOVER_REFRESH_TOKEN: SEED,
      CUSTOMER_REF_KEY: "k".repeat(64),
    };
    const round = async () => {
      const [scheduled] = scheduledConnectors(["clover"], env, { memory, organizationId: ORG }).connectors;
      return runSync({ connector: await scheduled!.make(), mode: "incremental", pipeline, memory, organizationId: ORG });
    };
    expect((await round()).ingested).toBe(2);
    expect((await round()).ingested).toBe(0);
    expect(mock.refreshes).toBe(2);
    expect(mock.refreshToken).toBe("clover-refresh-test-2");
    const raw = await memory.getCheckpoint(ORG, "clover", REFRESH_TOKEN_STREAM);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("clover-refresh-test");
  });
});
