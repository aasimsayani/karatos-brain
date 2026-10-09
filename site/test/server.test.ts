import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSiteHandler, issueFor, parseInquiry, type ServerOptions } from "../server.js";

const valid = {
  name: "Sam Rivera",
  email: "sam@example.com",
  business: "Example Jewelers",
  businessType: "retail",
  interests: ["brain_console", "custom_services"],
  seats: "3",
  message: "We run a POS and Shopify and want one dashboard.",
};

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(options: Partial<ServerOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: options.token === "fails" ? 500 : 201 });
  }) as unknown as typeof fetch;
  const handler = createSiteHandler({ html: "<h1>KaratOS</h1>", token: "t0ken", repo: "owner/private", fetch: fakeFetch, ...options });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/inquiry`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, calls, post };
}

describe("inquiry validation", () => {
  it("accepts a complete inquiry and parses seats", () => {
    const parsed = parseInquiry(valid);
    expect(parsed.ok && parsed.inquiry.seats).toBe(3);
  });

  it("names every missing or invalid field", () => {
    const parsed = parseInquiry({ email: "nope", interests: ["brain_console", "free_stuff"], seats: "0", businessType: "pawn" });
    expect(parsed).toEqual({ ok: false, fields: ["name", "email", "business", "businessType", "interests", "seats", "message"] });
    expect(parseInquiry(null)).toMatchObject({ ok: false });
  });

  it("treats seats as optional", () => {
    const parsed = parseInquiry({ ...valid, seats: "" });
    expect(parsed.ok && parsed.inquiry.seats).toBeUndefined();
  });
});

describe("inquiry issue", () => {
  it("fences visitor text so it can't inject markdown or mentions", () => {
    const parsed = parseInquiry({ ...valid, message: "hi @octocat ```\n# not a heading" });
    if (!parsed.ok) throw new Error("expected valid");
    const issue = issueFor(parsed.inquiry, "2026-10-09T12:00:00.000Z");
    expect(issue.title).toBe("Inquiry: Example Jewelers (Brain Console, Custom services)");
    expect(issue.labels).toEqual(["inquiry"]);
    expect(issue.body).toContain("````text\nhi @octocat ```\n# not a heading\n````");
    expect(issue.body).toContain("**Dashboard users**");
  });
});

describe("site server", () => {
  it("serves the page and a health check, and 404s anything else", async () => {
    const { base } = await start();
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toBe("<h1>KaratOS</h1>");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/.env`)).status).toBe(404);
  });

  it("files a valid inquiry as an issue in the private repo", async () => {
    const { post, calls } = await start();
    const res = await post(valid);
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/owner/private/issues");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t0ken");
    expect(JSON.parse(calls[0]!.init.body as string).title).toContain("Example Jewelers");
  });

  it("rejects invalid input without calling GitHub", async () => {
    const { post, calls } = await start();
    const bad = await post({ ...valid, email: "x" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid", fields: ["email"] });
    expect((await post("{not json")).status).toBe(400);
    expect((await post("x".repeat(20_000))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("quietly drops submissions that fill the hidden bot field", async () => {
    const { post, calls } = await start();
    expect((await post({ ...valid, website: "spam.example" })).status).toBe(202);
    expect(calls).toHaveLength(0);
  });

  it("limits each address per hour", async () => {
    const { post } = await start({ rateLimit: 2 });
    const headers = { "X-Forwarded-For": "203.0.113.9, 10.0.0.1" };
    expect((await post(valid, headers)).status).toBe(202);
    expect((await post(valid, headers)).status).toBe(202);
    expect((await post(valid, headers)).status).toBe(429);
    expect((await post(valid, { "X-Forwarded-For": "203.0.113.10" })).status).toBe(202);
  });

  it("says when the form isn't configured or GitHub fails", async () => {
    const off = await start({ token: undefined });
    expect((await off.post(valid)).status).toBe(503);
    server!.close();
    const failing = await start({ token: "fails" });
    expect((await failing.post(valid)).status).toBe(502);
  });
});
