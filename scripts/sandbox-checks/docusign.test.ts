import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import docusign from "./docusign.js";

describe("the Docusign sandbox check", () => {
  it("builds the Docusign connector for the developer environment with the test account's app", async () => {
    expect(docusign.credentials).toEqual(["SANDBOX_DOCUSIGN_INTEGRATION_KEY", "SANDBOX_DOCUSIGN_USER_ID", "SANDBOX_DOCUSIGN_ACCOUNT_ID", "SANDBOX_DOCUSIGN_PRIVATE_KEY"]);
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sent: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error: "consent_required" }), { status: 400 });
    });
    try {
      const connector = docusign.connector({
        SANDBOX_DOCUSIGN_INTEGRATION_KEY: "1a2b3c4d-1a2b-4c3d-8e9f-1a2b3c4d5e6f",
        SANDBOX_DOCUSIGN_USER_ID: "2b3c4d5e-2b3c-4d5e-9f0a-2b3c4d5e6f7a",
        SANDBOX_DOCUSIGN_ACCOUNT_ID: "3c4d5e6f-3c4d-4e5f-8a1b-3c4d5e6f7a8b",
        SANDBOX_DOCUSIGN_PRIVATE_KEY: pem,
      });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/hasn't consented/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://account-d.docusign.com/oauth/token"]);
    expect(new URLSearchParams(sent[0]!.body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  });
});
