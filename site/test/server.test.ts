import { createHash } from "node:crypto";
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
  return { base, calls, post, handler };
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

  it("labels holiday pilot sign-ups and titles them by the business", () => {
    const only = parseInquiry({ ...valid, interests: ["pilot"] });
    if (!only.ok) throw new Error("expected valid");
    const issue = issueFor(only.inquiry, "t");
    expect(issue.title).toBe("Holiday pilot: Example Jewelers");
    expect(issue.labels).toEqual(["inquiry", "pilot"]);
    expect(issue.body).toContain("**Interested in**\n```text\nHoliday pilot\n```");

    const mixed = parseInquiry({ ...valid, interests: ["pilot", "broken_system"], system: "Our POS" });
    if (!mixed.ok) throw new Error("expected valid");
    const mixedIssue = issueFor(mixed.inquiry, "t");
    expect(mixedIssue.title).toBe("Inquiry: Example Jewelers (Holiday pilot, A broken system)");
    expect(mixedIssue.labels).toEqual(["inquiry", "broken-system", "pilot"]);

    const plan = parseInquiry({ ...valid, interests: ["brain_console"] });
    if (!plan.ok) throw new Error("expected valid");
    expect(issueFor(plan.inquiry, "t").labels).toEqual(["inquiry"]);
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

/** Sends the path exactly as written, without the URL parser tidying away "..". */
function rawStatus(url: string): Promise<number | undefined> {
  const { origin } = new URL(url);
  return new Promise((resolve, reject) => {
    get(origin, { path: url.slice(origin.length) }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
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

  it("serves only the site's own font files, cached, and nothing else under /fonts/", async () => {
    const woff2 = Buffer.from("wOF2-test-bytes");
    const { base } = await start({ fonts: { "plex-sans-400.woff2": woff2 } });
    const font = await fetch(`${base}/fonts/plex-sans-400.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=2592000");
    expect(font.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await font.arrayBuffer()).equals(woff2)).toBe(true);
    for (const path of ["/fonts/missing.woff2", "/fonts/", "/fonts/constructor", "/fonts/__proto__", "/fonts/toString", "/fonts/plex-sans-400.woff2/x"]) {
      expect(await rawStatus(base + path), path).toBe(404);
    }
    expect(await rawStatus(`${base}/fonts/../server.ts`)).toBe(404);
    expect(await rawStatus(`${base}/fonts/../plex-sans-400.woff2`)).toBe(404);
    expect(await rawStatus(`${base}/fonts/%2e%2e%2fserver.ts`)).toBe(404);
    expect((await fetch(`${base}/fonts/plex-sans-400.woff2`, { method: "POST" })).status).toBe(404);
  });

  it("serves no fonts when none are given", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/fonts/plex-sans-400.woff2`)).status).toBe(404);
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
    const headers = { "X-Forwarded-For": "203.0.113.9" };
    expect((await post(valid, headers)).status).toBe(202);
    expect((await post(valid, headers)).status).toBe(202);
    expect((await post(valid, headers)).status).toBe(429);
    expect((await post(valid, { "X-Forwarded-For": "203.0.113.10" })).status).toBe(202);
  });

  it("can't be dodged by inventing forwarded addresses, because only the proxy's own entry counts", async () => {
    const { post } = await start({ rateLimit: 2 });
    // Railway's proxy appends the real address; whatever the sender wrote before it is ignored.
    for (const invented of ["1.1.1.1", "2.2.2.2"]) {
      expect((await post(valid, { "X-Forwarded-For": `${invented}, 203.0.113.9` })).status).toBe(202);
    }
    expect((await post(valid, { "X-Forwarded-For": "3.3.3.3, 203.0.113.9" })).status).toBe(429);
  });

  it("forgets addresses that have gone quiet once it tracks too many", async () => {
    let clock = Date.parse("2026-10-20T10:00:00Z");
    const { post, handler } = await start({ rateLimit: 1, now: () => new Date(clock) });
    for (let i = 0; i < 5_000; i++) {
      const res = await post(valid, { "X-Forwarded-For": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });
      expect(res.status).toBe(202);
    }
    expect((await post(valid, { "X-Forwarded-For": "10.0.0.0" })).status).toBe(429);
    expect(handler.trackedAddresses()).toBe(5_000);
    clock += 3_600_001;
    // The next inquiry sweeps every stale address, leaving only its own.
    expect((await post(valid, { "X-Forwarded-For": "203.0.113.50" })).status).toBe(202);
    expect(handler.trackedAddresses()).toBe(1);
    expect((await post(valid, { "X-Forwarded-For": "10.0.0.0" })).status).toBe(202);
  }, 60_000);

  it("refuses inquiries a browser says came from another site", async () => {
    const { post, calls, base } = await start();
    const host = new URL(base).host;
    expect((await post(valid, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(valid, { Origin: "not a url" })).status).toBe(403);
    expect((await post(valid, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await post(valid, { Origin: `http://${host}`, "Sec-Fetch-Site": "same-origin" })).status).toBe(202);
    expect((await post(valid)).status).toBe(202);
  });

  it("sends strict security headers on every response", async () => {
    const page = '<html><head><style>body{margin:0}</style></head><body><script>console.log(1)</script></body></html>';
    const { base } = await start({ html: page, fonts: { "f.woff2": Buffer.from("x") } });
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    for (const path of ["/", "/healthz", "/fonts/f.woff2", "/missing"]) {
      const res = await fetch(base + path);
      expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("permissions-policy")).toContain("camera=()");
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain(`script-src 'self' ${hash("console.log(1)")}`);
      expect(csp).toContain(`style-src 'self' ${hash("body{margin:0}")}`);
      for (const directive of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "connect-src 'self'", "font-src 'self'"]) expect(csp).toContain(directive);
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    }
  });

  it("sends the same headers on inquiry errors", async () => {
    const failed = await (await start({ token: "fails" })).post(valid);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(failed.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("says when the form isn't configured or GitHub fails", async () => {
    const off = await start({ token: undefined });
    expect((await off.post(valid)).status).toBe(503);
    server!.close();
    const failing = await start({ token: "fails" });
    expect((await failing.post(valid)).status).toBe(502);
  });
});
