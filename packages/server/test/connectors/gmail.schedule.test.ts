import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { GMAIL_MOCK_LABELS, gmailDocMock, gmailMessage } from "@karatos/connector-testkit";
import { REFRESH_TOKEN_STREAM, StaticDocumentationSource, scheduledConnectors } from "../../src/index.js";

const ORG = "test-jeweler";
// Test-only values, assembled at runtime.
const SECRET = ["client", "secret", "0".repeat(20)].join("-");
const SEED = ["RT", "TEST", "0"].join("-");

afterEach(() => {
  vi.unstubAllGlobals();
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
