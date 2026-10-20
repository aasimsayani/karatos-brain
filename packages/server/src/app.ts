import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import { DeadLetteredError, type BrainPipeline, type IntegrationStatus, type MemoryStore } from "@karatos/core";

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
        const recommendation = await options.memory.getRecommendation(options.organizationId, id!);
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
    ["GET", /^\/v1\/integrations$/, async () => [200, { integrations: options.integrations ?? [] }]],
    [
      "GET",
      /^\/v1\/entities\/([a-z][a-z0-9_]*)\/([^/]+)$/,
      async (_req, [kind, id]) => {
        const entity = await options.memory.getEntity(options.organizationId, kind!, decodeURIComponent(id!));
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
