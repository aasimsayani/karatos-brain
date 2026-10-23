import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@karatos/core";
import { scheduledConnectors } from "../../src/index.js";
import { ORG, buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Plaid factory", () => {
  const env = { PLAID_CLIENT_ID: "plaid-client-id", PLAID_SECRET: "plaid-secret-value", PLAID_ACCESS_TOKEN: ["access", "sandbox", "0".repeat(8)].join("-"), PLAID_ENVIRONMENT: "sandbox" };

  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("plaid", { PLAID_CLIENT_ID: "id", PLAID_ACCESS_TOKEN: secret });
    expect(reason).toBe("missing PLAID_SECRET, PLAID_ENVIRONMENT");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the app's keys and an access token", async () => {
    await buildsFromSettings("plaid", env);
  });

  /** The cursor the first /transactions/sync request carries, with Plaid stubbed out. */
  async function firstSyncCursor(store?: { memory: InMemoryStore; organizationId: string }): Promise<unknown> {
    const cursors: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/accounts/get")) return new Response(JSON.stringify({ accounts: [] }));
      cursors.push(JSON.parse(String(init?.body)).cursor ?? null);
      return new Response(JSON.stringify({ error_type: "INVALID_INPUT", error_code: "stop_here", error_message: "stop" }), { status: 400 });
    });
    try {
      const connector = await scheduledConnectors(["plaid"], env, store).connectors[0]!.make();
      const batches = connector.incrementalSync({ organizationId: ORG, cursor: null })[Symbol.asyncIterator]();
      await batches.next();
      await expect(batches.next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    return cursors[0];
  }

  it("starts the first incremental pass where the historical import ended", async () => {
    const memory = new InMemoryStore();
    await memory.saveCheckpoint(ORG, "plaid", "historical", JSON.stringify({ pass: "historical", step: "done", start: "c-test-9", next: "c-test-9" }));
    expect(await firstSyncCursor({ memory, organizationId: ORG })).toBe("c-test-9");
    expect(await firstSyncCursor()).toBeNull();
  });
});
