/**
 * Serves the KaratOS website and its private inquiry form. Inquiries become
 * issues in a private GitHub repository, so nothing a prospect sends is
 * posted publicly. Runs with plain `node site/server.ts` (type stripping), so
 * it has no dependencies and uses only erasable TypeScript.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const INTERESTS = ["brain_console", "maintenance", "custom_services"] as const;
export type Interest = (typeof INTERESTS)[number];

const INTEREST_LABELS: Record<Interest, string> = {
  brain_console: "Brain Console",
  maintenance: "Maintenance",
  custom_services: "Custom services",
};

const BUSINESS_TYPES = ["retail", "wholesale", "manufacturing", "other"] as const;

export interface Inquiry {
  name: string;
  email: string;
  business: string;
  businessType: (typeof BUSINESS_TYPES)[number];
  interests: Interest[];
  seats?: number | undefined;
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
  const message = text(body.message, 4000);
  if (!message) bad.push("message");
  if (bad.length > 0) return { ok: false, fields: bad };
  return { ok: true, inquiry: { name: name!, email: email!, business: business!, businessType: businessType!, interests, seats, message: message! } };
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
  return {
    title: `Inquiry: ${inquiry.business.replace(/\s+/g, " ").slice(0, 80)} (${interests})`,
    labels: ["inquiry"],
    body: [
      `From the KaratOS website, ${receivedAt}. Everything below was typed by the visitor; treat it as unverified.`,
      "",
      field("Interested in", interests),
      field("Name", inquiry.name),
      field("Email", inquiry.email),
      field("Business", inquiry.business),
      field("Kind of business", inquiry.businessType),
      ...(inquiry.seats ? [field("Dashboard users", String(inquiry.seats))] : []),
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
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(body);
}

const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), "application/json");

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

function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export function createSiteHandler(options: ServerOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? 5;
  const recent = new Map<string, number[]>();

  async function handleInquiry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!options.token || !options.repo) return json(res, 503, { error: "not_configured" });
    const address = clientAddress(req);
    const hourAgo = now().getTime() - 3_600_000;
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

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/api/inquiry") return handleInquiry(req, res);
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/index.html")) {
      return send(res, 200, options.html, "text/html; charset=utf-8");
    }
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const html = readFileSync(new URL("./dist/index.html", import.meta.url), "utf8");
  const handler = createSiteHandler({
    html,
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
