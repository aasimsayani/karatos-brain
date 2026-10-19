import { createServer, get, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
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

  it("reads the broken system's name when given, and treats blank as not given", () => {
    const parsed = parseInquiry({ ...valid, interests: ["broken_system"], system: "  Our POS  " });
    expect(parsed.ok && parsed.inquiry.system).toBe("Our POS");
    for (const blank of ["", "   ", null, undefined]) {
      const p = parseInquiry({ ...valid, system: blank });
      expect(p.ok && p.inquiry.system).toBeUndefined();
    }
  });

  it("refuses a system name that isn't short text", () => {
    expect(parseInquiry({ ...valid, system: "x".repeat(161) })).toEqual({ ok: false, fields: ["system"] });
    expect(parseInquiry({ ...valid, system: 42 })).toEqual({ ok: false, fields: ["system"] });
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
    expect(issue.title).toBe("Inquiry: Example Jewelers (Core plan, Custom services)");
    expect(issue.labels).toEqual(["inquiry"]);
    expect(issue.body).toContain("````text\nhi @octocat ```\n# not a heading\n````");
    expect(issue.body).toContain("**Dashboard users**");
    expect(issue.body).not.toContain("System that isn't working");
  });

  it("labels broken-system reports for triage and titles them by the system", () => {
    const only = parseInquiry({ ...valid, interests: ["broken_system"], seats: "", system: "Memo spreadsheet ```" });
    if (!only.ok) throw new Error("expected valid");
    const issue = issueFor(only.inquiry, "2026-10-14T12:00:00.000Z");
    expect(issue.title).toBe("Broken system: Memo spreadsheet ```");
    expect(issue.labels).toEqual(["inquiry", "broken-system"]);
    expect(issue.body).toContain("**System that isn't working**\n````text\nMemo spreadsheet ```\n````");

    const noSystem = parseInquiry({ ...valid, interests: ["broken_system"] });
    if (!noSystem.ok) throw new Error("expected valid");
    expect(issueFor(noSystem.inquiry, "t").title).toBe("Broken system: Example Jewelers");

    const mixed = parseInquiry({ ...valid, interests: ["broken_system", "custom_services"], system: "Our POS" });
    if (!mixed.ok) throw new Error("expected valid");
    const mixedIssue = issueFor(mixed.inquiry, "t");
    expect(mixedIssue.title).toBe("Inquiry: Example Jewelers (Custom services, A broken system)");
    expect(mixedIssue.labels).toEqual(["inquiry", "broken-system"]);
  });
});

function rawGet(url: string, headers: Record<string, string>): Promise<{ headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

describe("site server", () => {
  it("gzips the page for browsers that accept it, and only them", async () => {
    const { base } = await start();
    const zipped = await rawGet(base, { "accept-encoding": "br, gzip;q=0.8" });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers.vary).toBe("Accept-Encoding");
    expect(gunzipSync(zipped.body).toString()).toBe("<h1>KaratOS</h1>");
    for (const encoding of ["identity", "gzip;q=0", "deflate"]) {
      const plain = await rawGet(base, { "accept-encoding": encoding });
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(plain.body.toString()).toBe("<h1>KaratOS</h1>");
    }
    const none = await rawGet(base, {});
    expect(none.body.toString()).toBe("<h1>KaratOS</h1>");
  });

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
