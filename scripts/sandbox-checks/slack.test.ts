import { describe, expect, it, vi } from "vitest";
import slack from "./slack.js";

describe("the Slack sandbox check", () => {
  it("builds the Slack connector from the sandbox bot token only, checking it with auth.test before any read", async () => {
    expect(slack.credentials).toEqual(["SANDBOX_SLACK_BOT_TOKEN"]);
    const token = ["xoxb", "0".repeat(12), "TESTtokenTESTtoken"].join("-");
    const sent: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
    });
    try {
      const connector = slack.connector({ SANDBOX_SLACK_BOT_TOKEN: token });
      expect(connector.source).toBe("slack");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "invalid_auth" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://slack.com/api/auth.test", method: "POST", auth: `Bearer ${token}` }]);
  });;
});
