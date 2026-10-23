import { describe, expect, it, vi } from "vitest";
import twilio from "./twilio.js";

describe("the Twilio sandbox check", () => {
  it("builds the connector from an API key only, and sends it to Twilio with a year of history", async () => {
    // Assembled at runtime so no credential-shaped string sits in the repository.
    const account = ["AC", "0".repeat(32)].join("");
    const keySid = ["SK", "0".repeat(32)].join("");
    const secret = ["test", "0".repeat(28)].join("");
    expect(twilio.credentials).toEqual(["SANDBOX_TWILIO_ACCOUNT_SID", "SANDBOX_TWILIO_API_KEY_SID", "SANDBOX_TWILIO_API_KEY_SECRET"]);
    expect(() => twilio.connector({ SANDBOX_TWILIO_ACCOUNT_SID: account, SANDBOX_TWILIO_API_KEY_SID: account, SANDBOX_TWILIO_API_KEY_SECRET: secret })).toThrow("not the account SID");
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ code: 20003, message: "stop here" }, { status: 401 });
    });
    try {
      const connector = twilio.connector({ SANDBOX_TWILIO_ACCOUNT_SID: account, SANDBOX_TWILIO_API_KEY_SID: keySid, SANDBOX_TWILIO_API_KEY_SECRET: secret });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 20003 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect(url.origin + url.pathname).toBe(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`);
    const since = Date.parse(`${url.searchParams.get("DateSent>")}T00:00:00Z`);
    expect(Math.round((Date.now() - since) / 86_400_000)).toBeGreaterThanOrEqual(364);
    expect(Math.round((Date.now() - since) / 86_400_000)).toBeLessThanOrEqual(367);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from(`${keySid}:${secret}`).toString("base64")}`);
  });
});
