import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import { DeadLetteredError, monthOf, readValueReport, type BrainPipeline, type IntegrationStatus, type MemoryStore } from "@karatos/core";

export interface BrainAppOptions {
  pipeline: BrainPipeline;
  memory: MemoryStore;
  /** The only organization this instance serves. */
  organizationId: string;
  apiKey: string;
  /** Catalog integrations and whether this instance has their settings, worked out once at startup. */
  integrations?: IntegrationStatus[];
  maxBodyBytes?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Responses carry a client's business data, so nothing may cache them, sniff
 * them as another type, frame them or send them on as a referrer.
 */
export const API_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { ...API_SECURITY_HEADERS, "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

/** Longest bearer token compared; anything longer is refused outright. Instance keys are 64 characters. */
const MAX_KEY_BYTES = 512;

/** Zero-pads to a fixed width so the comparison takes the same time whatever the token's length. */
function padded(bytes: Buffer): Buffer {
  const out = Buffer.alloc(MAX_KEY_BYTES);
  bytes.copy(out);
  return out;
}

function authorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(apiKey, "utf8");
  if (given.length > MAX_KEY_BYTES || expected.length > MAX_KEY_BYTES) return false;
  // Compare fixed-width buffers in constant time first, so timing never reveals the key's length or contents;
  // the length check then rejects a token that only matched because of the padding.
  const same = timingSafeEqual(padded(given), padded(expected));
  return same && given.length === expected.length;
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new HttpError(400, "request body must be JSON");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

const FeedbackBody = z.object({
  outcome: z.enum(["accepted", "rejected", "overridden"]),
  actor: z.string().min(1),
  note: z.string().max(2000).optional(),
});

const ResultBody = z.object({
  /** What came back, in whole cents. Zero records that it was done and brought nothing back. */
  cents: z.number().int().nonnegative(),
  /** Needed only when the recommendation carries no impact to take it from. */
  kind: z.enum(["makes", "saves", "protects"]).optional(),
  actor: z.string().trim().min(1),
  note: z.string().max(2000).optional(),
});

/** The longest period one value report covers. */
const MAX_REPORT_DAYS = 366;

/** A YYYY-MM-DD day as the instant it starts, in UTC, or NaN when it isn't a real day: it must read back as itself. */
function dayStart(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/** Signal kinds are lowercase dotted names, such as bank.balance or receivable.invoice. */
/**
 * A path segment as the id it encodes. Clients encode ids (recommendation
 * ids carry colons, entity ids spaces), so the route has to decode them
 * before looking anything up; a malformed escape is the caller's mistake.
 */
function idFrom(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "the id in the path isn't validly encoded");
  }
}

const SIGNAL_KIND = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;

type Handler = (req: IncomingMessage, params: string[], url: URL) => Promise<[number, unknown]>;

/**
 * HTTP API for one client instance. Every request is pinned to the instance's
 * organization: events naming another organization are refused, so one
 * client's instance can never write into another client's data.
 */
export function createBrainApp(options: BrainAppOptions): RequestListener {
  const limit = options.maxBodyBytes ?? 1_000_000;

  const routes: [method: string, pattern: RegExp, handler: Handler][] = [
    [
      "POST",
      /^\/v1\/events$/,
      async (req) => {
        const body = await readJson(req, limit);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new HttpError(400, "event must be a JSON object");
        }
        const event = body as Record<string, unknown>;
        if (event.organizationId !== undefined && event.organizationId !== options.organizationId) {
          throw new HttpError(403, "this instance does not serve that organization");
        }
        const result = await options.pipeline.ingest({ ...event, organizationId: options.organizationId });
        return [
          result.duplicate ? 200 : 202,
          {
            id: result.event.id,
            duplicate: result.duplicate,
            entities: result.entities.length,
            signals: result.signals.length,
          },
        ];
      },
    ],
    [
      "POST",
      /^\/v1\/reason$/,
      async () => [200, { recommendations: await options.pipeline.reason(options.organizationId) }],
    ],
    [
      "GET",
      /^\/v1\/recommendations$/,
      async (_req, _params, url) => {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
        return [200, { recommendations: await options.memory.listRecommendations(options.organizationId, limit) }];
      },
    ],
    [
      "POST",
      /^\/v1\/recommendations\/([^/]+)\/feedback$/,
      async (req, [id]) => {
        const recommendation = await options.memory.getRecommendation(options.organizationId, idFrom(id!));
        if (!recommendation) throw new HttpError(404, "recommendation not found");
        const parsed = FeedbackBody.safeParse(await readJson(req, limit));
        if (!parsed.success) {
          throw new HttpError(400, "invalid feedback", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
        }
        await options.memory.recordFeedback({
          recommendationId: recommendation.id,
          organizationId: options.organizationId,
          outcome: parsed.data.outcome,
          actor: parsed.data.actor,
          ...(parsed.data.note ? { note: parsed.data.note } : {}),
          recordedAt: new Date().toISOString(),
        });
        return [201, { recorded: true }];
      },
    ],
    [
      "POST",
      /^\/v1\/recommendations\/([^/]+)\/result$/,
      async (req, [id]) => {
        const recommendation = await options.memory.getRecommendation(options.organizationId, idFrom(id!));
        if (!recommendation) throw new HttpError(404, "recommendation not found");
        const parsed = ResultBody.safeParse(await readJson(req, limit));
        if (!parsed.success) {
          throw new HttpError(400, "invalid result", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
        }
        const kind = parsed.data.kind ?? recommendation.impact?.kind;
        if (!kind) throw new HttpError(400, "this recommendation has no dollar estimate, so say whether the result made, saved or protected money");
        if (recommendation.impact && kind !== recommendation.impact.kind) {
          throw new HttpError(400, `this recommendation's estimate ${recommendation.impact.kind} money, so its result must too`);
        }
        await options.memory.recordValueResult({
          recommendationId: recommendation.id,
          organizationId: options.organizationId,
          kind,
          cents: parsed.data.cents,
          source: "reported",
          actor: parsed.data.actor,
          ...(parsed.data.note ? { note: parsed.data.note } : {}),
          recordedAt: new Date().toISOString(),
        });
        return [201, { recorded: true }];
      },
    ],
    [
      "GET",
      /^\/v1\/value$/,
      async (_req, _params, url) => {
        const fromDay = url.searchParams.get("from");
        const toDay = url.searchParams.get("to");
        // With no period, the month so far.
        if (fromDay === null && toDay === null) return [200, { report: await readValueReport(options.memory, options.organizationId, monthOf(new Date().toISOString())) }];
        const from = dayStart(fromDay ?? "");
        const to = dayStart(toDay ?? "");
        if (Number.isNaN(from) || Number.isNaN(to)) throw new HttpError(400, "from and to must both be days, such as 2026-10-01 and 2026-11-01");
        if (from >= to) throw new HttpError(400, "from must be before to; to is the day after the period");
        if (to - from > MAX_REPORT_DAYS * 86_400_000) throw new HttpError(400, `a report covers at most ${MAX_REPORT_DAYS} days`);
        const period = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
        return [200, { report: await readValueReport(options.memory, options.organizationId, period) }];
      },
    ],
    [
      "GET",
      /^\/v1\/signals$/,
      async (_req, _params, url) => {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 1000);
        const raw = url.searchParams.get("kind");
        const kinds = raw === null ? undefined : raw.split(",").map((k) => k.trim());
        if (kinds && (kinds.length > 10 || kinds.some((k) => !SIGNAL_KIND.test(k)))) {
          throw new HttpError(400, "kind must be up to 10 comma-separated signal kinds, such as bank.balance");
        }
        return [200, { signals: await options.memory.recentSignals(options.organizationId, limit, kinds) }];
      },
    ],
    ["GET", /^\/v1\/integrations$/, async () => [200, { integrations: options.integrations ?? [] }]],
    [
      "GET",
      /^\/v1\/entities\/([a-z][a-z0-9_]*)\/([^/]+)$/,
      async (_req, [kind, id]) => {
        const entity = await options.memory.getEntity(options.organizationId, kind!, idFrom(id!));
        if (!entity) throw new HttpError(404, "entity not found");
        return [200, { entity }];
      },
    ],
  ];

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") {
      send(res, req.method === "GET" ? 200 : 405, req.method === "GET" ? { status: "ok" } : { error: "method not allowed" });
      return;
    }

    const matches = routes
      .map(([method, pattern, handler]) => ({ method, handler, match: pattern.exec(path) }))
      .filter((r) => r.match);
    const route = matches.find((r) => r.method === req.method);
    if (!route) {
      send(res, matches.length ? 405 : 404, { error: matches.length ? "method not allowed" : "not found" });
      return;
    }
    if (!authorized(req, options.apiKey)) {
      send(res, 401, { error: "missing or invalid API key" });
      return;
    }

    route
      .handler(req, route.match!.slice(1), url)
      .then(([status, body]) => send(res, status, body))
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) });
        } else if (error instanceof DeadLetteredError) {
          send(res, 400, {
            error: "invalid event",
            deadLetterId: error.deadLetterId,
            details: error.cause.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        } else {
          console.error("unhandled error", error);
          send(res, 500, { error: "internal error" });
        }
      });
  };
}
