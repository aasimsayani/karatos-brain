import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { ZodError } from "zod";
import type { BrainPipeline } from "@karatos/core";

export interface BrainAppOptions {
  pipeline: BrainPipeline;
  /** The only organization this instance serves. */
  organizationId: string;
  apiKey: string;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function authorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
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

/**
 * HTTP API for one client instance. Every request is pinned to the instance's
 * organization: events naming another organization are refused, so one
 * client's instance can never write into another client's data.
 */
export function createBrainApp(options: BrainAppOptions): RequestListener {
  const limit = options.maxBodyBytes ?? 1_000_000;

  const routes: Record<string, (req: IncomingMessage) => Promise<[number, unknown]>> = {
    "POST /v1/events": async (req) => {
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
    "POST /v1/reason": async () => {
      const recommendations = await options.pipeline.reason(options.organizationId);
      return [200, { recommendations }];
    },
  };

  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      send(res, req.method === "GET" ? 200 : 405, req.method === "GET" ? { status: "ok" } : { error: "method not allowed" });
      return;
    }

    const route = routes[`${req.method} ${path}`];
    if (!route) {
      const known = Object.keys(routes).some((r) => r.endsWith(` ${path}`));
      send(res, known ? 405 : 404, { error: known ? "method not allowed" : "not found" });
      return;
    }
    if (!authorized(req, options.apiKey)) {
      send(res, 401, { error: "missing or invalid API key" });
      return;
    }

    route(req)
      .then(([status, body]) => send(res, status, body))
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) });
        } else if (error instanceof ZodError) {
          send(res, 400, {
            error: "invalid event",
            details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        } else {
          console.error("unhandled error", error);
          send(res, 500, { error: "internal error" });
        }
      });
  };
}
