import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { GOOGLE_MOCK_ROOT, googleFile, googleWorkspaceDocMock } from "@karatos/connector-testkit";
import { REFRESH_TOKEN_STREAM, StaticDocumentationSource, scheduledConnectors } from "../../src/index.js";

const ORG = "test-jeweler";
// Test-only values, assembled at runtime.
const SECRET = ["client", "secret", "0".repeat(20)].join("-");
const SEED = ["RT", "TEST", "0"].join("-");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Workspace on a schedule", () => {
  it("refreshes with the seed token every round, since Google doesn't rotate it, and stores nothing it didn't get", async () => {
    googleFile.reset();
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const mock = googleWorkspaceDocMock({ files: googleFile.many(2).map((f) => ({ ...f, modifiedTime: recent })), refreshToken: SEED, calendars: { primary: [] } });
    vi.stubGlobal("fetch", mock.fetch);
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const env = {
      GOOGLE_CLIENT_ID: "000000000000-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: SECRET,
      GOOGLE_WORKSPACE_REFRESH_TOKEN: SEED,
      GOOGLE_DRIVE_ROOT_FOLDER_ID: GOOGLE_MOCK_ROOT,
      CORRESPONDENT_HASH_KEY: "0".repeat(64),
    };
    const round = async () => {
      const [scheduled] = scheduledConnectors(["google_workspace"], env, { memory, organizationId: ORG }).connectors;
      return runSync({ connector: await scheduled!.make(), mode: "incremental", pipeline, memory, organizationId: ORG, sleep: async () => {} });
    };
    expect((await round()).ingested).toBe(2);
    // The second round reads Drive's change feed and Calendar's sync token from the first one's checkpoint: nothing new.
    expect(await round()).toMatchObject({ ingested: 0, duplicates: 0 });
    expect(mock.refreshes).toBe(2);
    expect(await memory.getCheckpoint(ORG, "google_workspace", REFRESH_TOKEN_STREAM)).toBeNull();
  });
});
