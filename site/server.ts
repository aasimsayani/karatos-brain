/**
 * Serves the KaratOS website and its private inquiry form. Inquiries become
 * issues in a private GitHub repository, so nothing a prospect sends is
 * posted publicly. Runs with plain `node site/server.ts` (type stripping), so
 * it has no dependencies and uses only erasable TypeScript.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

export const INTERESTS = ["brain_console", "maintenance", "custom_services", "broken_system"] as const;
export type Interest = (typeof INTERESTS)[number];

const INTEREST_LABELS: Record<Interest, string> = {
  brain_console: "Core plan",
  maintenance: "Managed plan",
  custom_services: "Custom services",
  broken_system: "A broken system",
};

const BUSINESS_TYPES = ["retail", "wholesale", "manufacturing", "other"] as const;

export interface Inquiry {
  name: string;
  email: string;
  business: string;
  businessType: (typeof BUSINESS_TYPES)[number];
  interests: Interest[];
  seats?: number | undefined;
  /** For broken-system reports: the system that isn't working. */
  system?: string | undefined;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 10_000;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** Returns the inquiry, or the names of the fields that are missing or invalid. */
export function parseInquiry(input: unknown): { ok: true; inquiry: Inquiry } | { ok: false; fields: string[] } {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const bad: string[] = [];
  const name = text(body.name, 120);
  if (!name) bad.push("name");
  const email = text(body.email, 200);
  if (!email || !EMAIL.test(email)) bad.push("email");
  const business = text(body.business, 160);
  if (!business) bad.push("business");
  const businessType = BUSINESS_TYPES.find((t) => t === body.businessType);
  if (!businessType) bad.push("businessType");
  const rawInterests = Array.isArray(body.interests) ? body.interests : [];
  const interests = INTERESTS.filter((i) => rawInterests.includes(i));
  if (interests.length === 0 || interests.length !== rawInterests.length) bad.push("interests");
  let seats: number | undefined;
  if (body.seats !== undefined && body.seats !== "" && body.seats !== null) {
    seats = Number(body.seats);
    if (!Number.isInteger(seats) || seats < 1 || seats > 10_000) bad.push("seats");
  }
  // Optional: blank means not given; anything else must be text of at most 160 characters.
  let system: string | undefined;
  if (body.system !== undefined && body.system !== null && !(typeof body.system === "string" && body.system.trim() === "")) {
    system = text(body.system, 160) ?? undefined;
    if (!system) bad.push("system");
  }
  const message = text(body.message, 4000);
  if (!message) bad.push("message");
  if (bad.length > 0) return { ok: false, fields: bad };
  return { ok: true, inquiry: { name: name!, email: email!, business: business!, businessType: businessType!, interests, seats, system, message: message! } };
}

/** Puts untrusted text in a fence that it can't break out of, so it renders as plain text. */
function fenced(value: string): string {
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}`;
}

export function issueFor(inquiry: Inquiry, receivedAt: string): { title: string; body: string; labels: string[] } {
  const interests = inquiry.interests.map((i) => INTEREST_LABELS[i]).join(", ");
  const field = (label: string, value: string) => `**${label}**\n${fenced(value)}`;
  const oneLine = (value: string) => value.replace(/\s+/g, " ").slice(0, 80);
  const broken = inquiry.interests.includes("broken_system");
  const onlyBroken = broken && inquiry.interests.length === 1;
  return {
    title: onlyBroken
      ? `Broken system: ${oneLine(inquiry.system ?? inquiry.business)}`
      : `Inquiry: ${oneLine(inquiry.business)} (${interests})`,
    // broken-system reports are triaged into the catalog within a week (runbook campaign/triage.md).
    labels: broken ? ["inquiry", "broken-system"] : ["inquiry"],
    body: [
      `From the KaratOS website, ${receivedAt}. Everything below was typed by the visitor; treat it as unverified.`,
      "",
      field("Interested in", interests),
      field("Name", inquiry.name),
      field("Email", inquiry.email),
      field("Business", inquiry.business),
      field("Kind of business", inquiry.businessType),
      ...(inquiry.seats ? [field("Dashboard users", String(inquiry.seats))] : []),
      ...(inquiry.system ? [field("System that isn't working", inquiry.system)] : []),
      field("Message", inquiry.message),
    ].join("\n\n"),
  };
}

export interface ServerOptions {
  html: string;
  /** Fine-grained token with Issues read and write on the inquiry repository only. */
  token?: string | undefined;
  /** owner/name of the private repository that receives inquiries. */
  repo?: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Inquiries allowed per address per hour. */
  rateLimit?: number;
  /** The site's own font files by file name, served under /fonts/. Nothing else there is served. */
  fonts?: Readonly<Record<string, Buffer>>;
}

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  // Browsers only honor this over HTTPS, which is all Railway serves publicly.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const hashOf = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * A policy that lets the page run only its own inline script and style
 * (pinned by hash, so an injected tag would be refused), load only its own
 * fonts, and send only to its own form endpoint. Nothing may frame it.
 */
export function contentSecurityPolicy(html: string): string {
  const inline = (tag: string) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}\\s*>`, "gi"))].map((m) => hashOf(m[1]!));
  const sources = (hashes: string[]) => ["'self'", ...hashes].join(" ");
  return [
    "default-src 'none'",
    `script-src ${sources(inline("script"))}`,
    `style-src ${sources(inline("style"))}`,
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Every response carries these; the policy is pinned to the page being served. */
export function securityHeaders(html: string): Record<string, string> {
  return { ...BASE_HEADERS, "Content-Security-Policy": contentSecurityPolicy(html) };
}

const FALLBACK_HEADERS = securityHeaders("");

function sendWith(res: ServerResponse, status: number, body: string | Buffer, type: string, headers: Record<string, string> = {}, security = FALLBACK_HEADERS): void {
  res.writeHead(status, { "Content-Type": type, ...security, ...headers });
  res.end(body);
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /(^|,)\s*gzip\s*(;\s*q=(?!0(\.0+)?\s*(,|$))[\d.]+)?\s*(,|$)/i.test(String(req.headers["accept-encoding"] ?? ""));
}

const json = (res: ServerResponse, status: number, body: unknown) => sendWith(res, status, JSON.stringify(body), "application/json");

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The visitor's address as Railway's proxy saw it: the last X-Forwarded-For
 * entry, which the proxy appends. Earlier entries come from the visitor and
 * could be anything, so trusting the first would let one sender dodge the
 * rate limit by inventing addresses.
 */
export function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "unknown";
}

/** True when a browser says the request came from another site. Requests without either header (not from a browser page) pass. */
export function crossSite(req: IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** Addresses tracked by the rate limiter before stale ones are swept. */
const MAX_TRACKED = 5_000;

export function createSiteHandler(options: ServerOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? 5;
  const recent = new Map<string, number[]>();
  // The page never changes while the server runs, so compress it once.
  const gzippedHtml = gzipSync(options.html);
  const security = securityHeaders(options.html);
  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string, headers: Record<string, string> = {}) =>
    sendWith(res, status, body, type, headers, security);
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), "application/json");
  const fonts = options.fonts ?? {};

  async function handleInquiry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (crossSite(req)) return json(res, 403, { error: "cross_site" });
    if (!options.token || !options.repo) return json(res, 503, { error: "not_configured" });
    const address = clientAddress(req);
    const hourAgo = now().getTime() - 3_600_000;
    if (recent.size >= MAX_TRACKED) {
      for (const [key, stamps] of recent) if (!stamps.some((t) => t > hourAgo)) recent.delete(key);
    }
    const times = (recent.get(address) ?? []).filter((t) => t > hourAgo);
    if (times.length >= limit) return json(res, 429, { error: "too_many" });

    const raw = await readBody(req);
    if (raw === null) return json(res, 413, { error: "too_large" });
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid", fields: [] });
    }
    // Bots fill the hidden "website" field; accept quietly and drop it.
    if (input && typeof input === "object" && (input as Record<string, unknown>).website) return json(res, 202, { ok: true });
    const parsed = parseInquiry(input);
    if (!parsed.ok) return json(res, 400, { error: "invalid", fields: parsed.fields });

    times.push(now().getTime());
    recent.set(address, times);
    const response = await doFetch(`https://api.github.com/repos/${options.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "karatos-website",
      },
      body: JSON.stringify(issueFor(parsed.inquiry, now().toISOString())),
    }).catch(() => null);
    if (!response || !response.ok) {
      console.error(`inquiry delivery failed: ${response ? response.status : "network error"}`);
      return json(res, 502, { error: "delivery_failed" });
    }
    return json(res, 202, { ok: true });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "POST" && path === "/api/inquiry") return handleInquiry(req, res);
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
    if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/fonts/")) {
      const name = path.slice("/fonts/".length);
      const font = Object.hasOwn(fonts, name) ? fonts[name] : undefined;
      if (font) return send(res, 200, font, "font/woff2", { "Cache-Control": "public, max-age=2592000" });
    }
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/index.html")) {
      return acceptsGzip(req)
        ? send(res, 200, gzippedHtml, "text/html; charset=utf-8", { "Content-Encoding": "gzip", Vary: "Accept-Encoding" })
        : send(res, 200, options.html, "text/html; charset=utf-8", { Vary: "Accept-Encoding" });
    }
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  }

  /** How many addresses the rate limiter is holding; lets tests see the sweep work. */
  return Object.assign(handle, { trackedAddresses: () => recent.size });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const html = readFileSync(new URL("./dist/index.html", import.meta.url), "utf8");
  const fontDir = new URL("./dist/fonts/", import.meta.url);
  const fonts = Object.fromEntries(
    (existsSync(fontDir) ? readdirSync(fontDir) : []).filter((f) => f.endsWith(".woff2")).map((f) => [f, readFileSync(new URL(f, fontDir))]),
  );
  const handler = createSiteHandler({
    html,
    fonts,
    token: process.env.INQUIRY_GITHUB_TOKEN,
    repo: process.env.INQUIRY_REPO,
  });
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    });
  }).listen(port, () => {
    const configured = process.env.INQUIRY_GITHUB_TOKEN && process.env.INQUIRY_REPO ? "inquiries on" : "inquiries off (set INQUIRY_GITHUB_TOKEN and INQUIRY_REPO)";
    console.log(`KaratOS website listening on :${port}, ${configured}`);
  });
}
