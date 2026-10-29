import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSiteHandler, demoTarget, isDemoPath, type ServerOptions } from "../server.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A stand-in for the demo console: records what reaches it and answers as told. */
async function fakeConsole(answer: (seen: Seen, res: import("node:http").ServerResponse) => void = (_, res) => res.end("console")) {
  const seen: Seen[] = [];
  const port = await listen(
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        seen.push(s);
        answer(s, res);
      });
    }),
  );
  return { seen, url: `http://127.0.0.1:${port}` };
}

async function site(options: Partial<ServerOptions>) {
  const handler = createSiteHandler({ html: "<h1>KaratOS</h1>", ...options });
  const port = await listen(createServer((req, res) => void handler(req, res)));
  return `http://127.0.0.1:${port}`;
}

/** node:http rather than fetch, so Host and X-Forwarded-For can be set the way Railway's proxy sets them. */
function call(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const url = new URL(base);
    const req = request({ hostname: url.hostname, port: url.port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

describe("demo console address", () => {
  it("takes plain http on Railway's private network or this machine", () => {
    expect(demoTarget("http://demo-console.railway.internal:8080")?.host).toBe("demo-console.railway.internal:8080");
    expect(demoTarget("http://127.0.0.1:9000/")?.port).toBe("9000");
    expect(demoTarget("http://localhost:9000")?.hostname).toBe("localhost");
  });

  it("won't send visitors anywhere else", () => {
    for (const bad of [
      undefined,
      "",
      "not a url",
      "https://demo-console.railway.internal",
      "http://demo.example.com",
      "http://railway.internal.example.com",
      "http://evilrailway.internal",
      "http://user:pw@demo-console.railway.internal",
      "http://demo-console.railway.internal/demo",
      "http://demo-console.railway.internal/?a=1",
      "http://demo-console.railway.internal/#x",
      "file:///etc/passwd",
    ]) {
      expect(demoTarget(bad), String(bad)).toBeNull();
    }
  });

  it("matches /demo and what is under it, nothing else", () => {
    expect(isDemoPath("/demo")).toBe(true);
    expect(isDemoPath("/demo/")).toBe(true);
    expect(isDemoPath("/demo/api/money")).toBe(true);
    expect(isDemoPath("/demonstration")).toBe(false);
    expect(isDemoPath("/")).toBe(false);
    expect(isDemoPath("/x/demo")).toBe(false);
  });
});

describe("/demo route", () => {
  it("says the demo isn't running when no console is set, and leaves the rest of the site alone", async () => {
    const base = await site({});
    const res = await call(base, "/demo/");
    expect(res.status).toBe(503);
    expect(res.body).toBe("The demo isn't running yet.");
    expect(res.headers["retry-after"]).toBe("3600");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect((await call(base, "/")).status).toBe(200);
  });

  it("treats a console address it won't use as no console", async () => {
    const base = await site({ demoUrl: "https://demo.example.com" });
    expect((await call(base, "/demo/")).status).toBe(503);
  });

  it("passes the path, query, method and body through unchanged", async () => {
    const consoleApp = await fakeConsole((s, res) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const base = await site({ demoUrl: consoleApp.url });
    const res = await call(base, "/demo/api/recommendations/rec_1/feedback?x=1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://karatos.app", Host: "karatos.app" },
      body: '{"verdict":"useful"}',
    });
    expect(res.status).toBe(201);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers["content-type"]).toBe("application/json");
    const [seen] = consoleApp.seen;
    expect(seen).toMatchObject({ method: "POST", url: "/demo/api/recommendations/rec_1/feedback?x=1", body: '{"verdict":"useful"}' });
    expect(seen!.headers["content-length"]).toBe("20");
    // The console's same-origin check compares Origin with Host, so Host must be the site's.
    expect(seen!.headers.host).toBe("karatos.app");
    expect(seen!.headers.origin).toBe("https://karatos.app");
    expect(seen!.headers["x-forwarded-proto"]).toBe("https");
  });

  it("forwards only the address Railway's proxy saw", async () => {
    const consoleApp = await fakeConsole();
    const base = await site({ demoUrl: consoleApp.url });
    await call(base, "/demo/", { headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.9" } });
    expect(consoleApp.seen[0]!.headers["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("drops connection-only headers both ways and keeps every cookie the console sets", async () => {
    const consoleApp = await fakeConsole((_, res) => {
      res.setHeader("Set-Cookie", ["a=1; Path=/demo", "b=2; Path=/demo"]);
      res.setHeader("Keep-Alive", "timeout=99");
      res.setHeader("Content-Security-Policy", "default-src 'self'");
      res.end("page");
    });
    const base = await site({ demoUrl: consoleApp.url });
    const res = await call(base, "/demo/", { headers: { "Proxy-Authorization": "Basic x", Upgrade: "websocket", Connection: "upgrade", TE: "trailers" } });
    const sent = consoleApp.seen[0]!.headers;
    expect(sent["proxy-authorization"]).toBeUndefined();
    expect(sent.upgrade).toBeUndefined();
    expect(sent.te).toBeUndefined();
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/demo", "b=2; Path=/demo"]);
    // Node sets its own Keep-Alive on the site's connection; the console's must not leak through.
    expect(res.headers["keep-alive"]).not.toBe("timeout=99");
    // The console's own policy applies to its pages, not the homepage's.
    expect(res.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(res.body).toBe("page");
  });

  it("passes redirects through for the browser to follow", async () => {
    const consoleApp = await fakeConsole((_, res) => {
      res.writeHead(302, { Location: "/demo/" });
      res.end();
    });
    const base = await site({ demoUrl: consoleApp.url });
    const res = await call(base, "/demo");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/demo/");
    expect(consoleApp.seen[0]!.url).toBe("/demo");
  });

  it("blocks paths that could step outside /demo before they reach the console", async () => {
    const consoleApp = await fakeConsole();
    const base = await site({ demoUrl: consoleApp.url });
    for (const path of ["/demo/../v1/events", "/demo/%2e%2e/v1", "/demo/.%2E/v1", "/demo/..", "/demo/./x", "/demo/..?q", "/demo/x%2Fy", "/demo/x%5cy", "/demo/x\\..\\y"]) {
      const res = await call(base, path);
      expect(res.status, path).toBe(400);
    }
    expect(consoleApp.seen).toHaveLength(0);
    // Dots inside a name are fine.
    expect((await call(base, "/demo/app.js")).status).toBe(200);
  });

  it("stops a body over 64 KB without passing it on", async () => {
    const consoleApp = await fakeConsole();
    const base = await site({ demoUrl: consoleApp.url });
    const res = await call(base, "/demo/api/x", { method: "POST", body: "x".repeat(64_001) });
    expect(res.status).toBe(413);
    expect(consoleApp.seen).toHaveLength(0);
    expect((await call(base, "/demo/api/x", { method: "POST", body: "x".repeat(64_000) })).status).toBe(200);
  });

  it("tells the visitor the demo isn't available when the console is down", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    servers.splice(servers.indexOf(closed), 1);
    const base = await site({ demoUrl: `http://127.0.0.1:${port}` });
    const res = await call(base, "/demo/");
    expect(res.status).toBe(502);
    expect(res.body).toContain("The demo isn't available right now");
  });

  it("gives up on a console that doesn't answer in time", async () => {
    const consoleApp = await fakeConsole(() => {
      // never answers
    });
    const base = await site({ demoUrl: consoleApp.url, demoTimeoutMs: 100 });
    const res = await call(base, "/demo/");
    expect(res.status).toBe(502);
  });
});
