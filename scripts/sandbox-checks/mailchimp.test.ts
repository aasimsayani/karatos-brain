import { describe, expect, it, vi } from "vitest";
import mailchimp from "./mailchimp.js";

describe("the Mailchimp sandbox check", () => {
  it("builds the Mailchimp connector for the key's data center, with Basic auth", async () => {
    expect(mailchimp.credentials).toEqual(["SANDBOX_MAILCHIMP_API_KEY"]);
    const key = `${"b".repeat(32)}-us21`;
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ title: "stop" }), { status: 400 });
    });
    try {
      const batches = mailchimp.connector({ SANDBOX_MAILCHIMP_API_KEY: key }).historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Mailchimp answered HTTP 400 to lists: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url.split("?")[0])).toEqual(["https://us21.api.mailchimp.com/3.0/lists"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from(`karatos:${key}`).toString("base64")}`);
  });
});
