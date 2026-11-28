import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import { DeadLetteredError, DEFAULT_FEEDBACK_POLICY, DOC_SEARCH_MAX_QUERY_CHARS, DOC_SEARCH_MAX_RESULTS, INTEGRATIONS, monthOf, readFeedbackSummary, readValueReport, type BrainPipeline, type IntegrationStatus, type MemoryStore } from "@karatos/core";
import { addDays, ASK_MAX_QUESTION_CHARS, DEFAULT_BRIEF_TIME_ZONE, isDay, localDay, VERIFY_MAX_DAYS, verifyPeriod, type BriefSyncInput } from "@karatos/retail";
import { readAnswer, type AskSources } from "./ask.js";
import type { DocSearch } from "./doc-search.js";
import { HttpError, idFrom, readJson } from "./http.js";
import { SIGNAL_KIND, VerifyBody } from "./inputs.js";

export { VERIFY_MAX_TOLERANCE_CENTS } from "./inputs.js";
import { readDailyBrief, yesterdayIn } from "./brief.js";
import { reasonNow, type ReasonPass } from "./reasoning.js";
import { VerifyBusyError, type Verifier } from "./verify.js";
import { workRoutes, type BrainWorkOptions } from "./tasks.js";
import { MAX_SUPPORT_EVENT_DAYS, SUPPORT_EVENT_DAYS, supportStatus, type SupportStatusOptions } from "./support.js";

export interface BrainAppOptions {
  pipeline: BrainPipeline;
  memory: MemoryStore;
  /** The only organization this instance serves. */
  organizationId: string;
  apiKey: string;
  /**
   * Optional key for support access: it reaches only the diagnostic routes
   * (health, integration setup and support status), never business data.
   * Must differ from apiKey.
   */
  supportApiKey?: string;
  /** What GET /v1/support/status reports. Without it that route answers 503. */
  support?: SupportStatusOptions;
  /** Catalog integrations and whether this instance has their settings, worked out once at startup. */
  integrations?: IntegrationStatus[];
  maxBodyBytes?: number;
  /** What GET /v1/brief and /v1/ask need beyond the store. Without it, days are America/New_York days and sync results are left out. */
  brief?: BrainBriefOptions;
  /** What POST /v1/verify runs. Without it that route answers 503. Its periods are days in brief.timeZone. */
  verify?: Verifier;
  /**
   * Runs POST /v1/reason's pass. An instance hands it to the reasoning runner,
   * which records the run and keeps it from overlapping a scheduled one.
   * Without it the route calls reasonNow directly.
   */
  reason?: (pass: () => Promise<ReasonPass>) => Promise<ReasonPass>;
  /** Reasoning sessions and agent tasks at /v1/sessions and /v1/tasks. Without it those routes answer 503. */
  work?: BrainWorkOptions;
  /**
   * Documentation search, for GET /v1/docs/search and for "how do I" and
   * "where is" questions to /v1/ask. Without it the route answers 503 and
   * ask says documentation search isn't set up.
   */
  docs?: Pick<DocSearch, "search" | "embedder">;
}

export interface BrainBriefOptions {
  timeZone: string;
  sync?: () => BriefSyncInput;
  now?: () => Date;
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

/** The largest body POST /v1/ask reads: a question is at most ASK_MAX_QUESTION_CHARS characters. */
export const ASK_MAX_BODY_BYTES = 8_192;

const AskBody = z.object({ question: z.string() });

/** The largest body POST /v1/verify reads. */
export const VERIFY_MAX_BODY_BYTES = 1_024;

/** A question as asked, trimmed, or a 400 saying what is wrong with it. */
function questionFrom(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "question must be a string, such as \"what sold this week?\"");
  const question = value.trim();
  if (!question) throw new HttpError(400, "question can't be empty");
  if ([...question].length > ASK_MAX_QUESTION_CHARS) throw new HttpError(400, `question must be at most ${ASK_MAX_QUESTION_CHARS} characters`);
  return question;
}

/** The longest period one value report covers. */
const MAX_REPORT_DAYS = 366;

/** A YYYY-MM-DD day as the instant it starts, in UTC, or NaN when it isn't a real day: it must read back as itself. */
function dayStart(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

export type Handler = (req: IncomingMessage, params: string[], url: URL) => Promise<[number, unknown]>;

/** Who a route admits: only the instance key, or the support key too. */
export type RouteAccess = "instance" | "support";

export interface BrainRoute {
  method: string;
  pattern: RegExp;
  handler: Handler;
  access: RouteAccess;
}

/** Said to a caller using the support key on any route that isn't diagnostic. */
export const SUPPORT_KEY_REFUSAL =
  "the support key reaches only GET /healthz, GET /v1/integrations and GET /v1/support/status; this route needs the instance API key";

/**
 * HTTP API for one client instance. Every request is pinned to the instance's
 * organization: events naming another organization are refused, so one
 * client's instance can never write into another client's data.
 */
export function createBrainApp(options: BrainAppOptions): RequestListener {
  const supportKey = options.supportApiKey || undefined;
  if (supportKey !== undefined && supportKey === options.apiKey) throw new Error("the support key must differ from the instance API key");
  const routes = brainRoutes(options);

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") {
      send(res, req.method === "GET" ? 200 : 405, req.method === "GET" ? { status: "ok" } : { error: "method not allowed" });
      return;
    }

    const matches = routes.map((route) => ({ route, match: route.pattern.exec(path) })).filter((r) => r.match);
    const found = matches.find((r) => r.route.method === req.method);
    if (!found) {
      send(res, matches.length ? 405 : 404, { error: matches.length ? "method not allowed" : "not found" });
      return;
    }
    // Both keys are always compared, each in constant time, so timing never says which one a token was close to.
    const instance = authorized(req, options.apiKey);
    const support = supportKey !== undefined && authorized(req, supportKey);
    if (!instance && !support) {
      send(res, 401, { error: "missing or invalid API key" });
      return;
    }
    if (!instance && found.route.access !== "support") {
      send(res, 403, { error: SUPPORT_KEY_REFUSAL });
      return;
    }

    found.route
      .handler(req, found.match!.slice(1), url)
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

/**
 * Every route but /healthz, with who it admits. Only diagnostic routes,
 * which carry names, timings and counts but no business data, admit the
 * support key; a test walks this table so a new route is covered.
 */
export function brainRoutes(options: BrainAppOptions): BrainRoute[] {
  const limit = options.maxBodyBytes ?? 1_000_000;

  const ops = brainOperations(options);

  const table: [method: string, pattern: RegExp, handler: Handler, access?: RouteAccess][] = [
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
      async () => [200, await ops.reason()],
    ],
    [
      "GET",
      /^\/v1\/recommendations$/,
      async (_req, _params, url) => {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
        return [200, await ops.recommendations(limit)];
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
      async (_req, _params, url) => [200, await ops.value(url.searchParams.get("from"), url.searchParams.get("to"))],
    ],
    [
      "GET",
      /^\/v1\/feedback$/,
      async () => [200, await ops.feedback()],
    ],
    [
      "GET",
      /^\/v1\/signals$/,
      async (_req, _params, url) => {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 1000);
        const raw = url.searchParams.get("kind");
        const kinds = raw === null ? undefined : raw.split(",").map((k) => k.trim());
        return [200, await ops.signals(kinds, limit)];
      },
    ],
    [
      "GET",
      /^\/v1\/brief$/,
      async (_req, _params, url) => [200, await ops.brief(url.searchParams.get("date"))],
    ],
    [
      "GET",
      /^\/v1\/ask$/,
      async (_req, _params, url) => {
        const q = url.searchParams.get("q");
        if (q === null) throw new HttpError(400, "ask with ?q=, such as ?q=what+sold+this+week");
        return [200, await ops.ask(q)];
      },
    ],
    [
      "POST",
      /^\/v1\/ask$/,
      async (req) => {
        const parsed = AskBody.safeParse(await readJson(req, Math.min(limit, ASK_MAX_BODY_BYTES)));
        if (!parsed.success) throw new HttpError(400, "the body must be a JSON object with a question, such as {\"question\": \"what sold this week?\"}");
        return [200, await ops.ask(parsed.data.question)];
      },
    ],
    [
      "GET",
      /^\/v1\/docs\/search$/,
      async (_req, _params, url) => [200, await ops.searchDocs(url.searchParams.get("q"), url.searchParams.get("limit"))],
    ],
    [
      "POST",
      /^\/v1\/verify$/,
      async (req) => {
        if (!options.verify) throw new HttpError(503, "sync verification isn't set up on this instance");
        const parsed = VerifyBody.safeParse(await readJson(req, Math.min(limit, VERIFY_MAX_BODY_BYTES)));
        if (!parsed.success) {
          throw new HttpError(400, "the body must be {\"from\": day, \"to\": day}, optionally with \"system\" and \"toleranceCents\"", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
        }
        return [200, await ops.verify(parsed.data)];
      },
    ],
    ["GET", /^\/v1\/integrations$/, async () => [200, { integrations: options.integrations ?? [] }], "support"],
    [
      "GET",
      /^\/v1\/support\/status$/,
      async (_req, _params, url) => {
        if (!options.support) throw new HttpError(503, "support status isn't set up on this instance");
        const raw = url.searchParams.get("days");
        const days = raw === null ? SUPPORT_EVENT_DAYS : Number(raw);
        if (!Number.isInteger(days) || days < 1 || days > MAX_SUPPORT_EVENT_DAYS) {
          throw new HttpError(400, `days must be a whole number from 1 to ${MAX_SUPPORT_EVENT_DAYS}`);
        }
        return [200, await supportStatus(options.organizationId, options.support, options.integrations ?? [], days)];
      },
      "support",
    ],
    [
      "GET",
      /^\/v1\/entities\/([a-z][a-z0-9_]*)\/([^/]+)$/,
      async (_req, [kind, id]) => {
        const entity = await options.memory.getEntity(options.organizationId, kind!, idFrom(id!));
        if (!entity) throw new HttpError(404, "entity not found");
        return [200, { entity }];
      },
    ],
    ...workRoutes(options, ops, limit),
  ];

  return table.map(([method, pattern, handler, access]) => ({ method, pattern, handler, access: access ?? "instance" }));
}

/**
 * The read-only operations behind the routes, each with its own checks, so a
 * route and an agent task that runs the same operation answer the same way.
 * None writes to a vendor's system; reason records recommendations in the
 * instance's own store, as POST /v1/reason always has.
 */
export function brainOperations(options: BrainAppOptions) {
  const timeZone = () => options.brief?.timeZone ?? DEFAULT_BRIEF_TIME_ZONE;
  const now = () => (options.brief?.now ?? (() => new Date()))();
  const askSources = (): AskSources => ({
    memory: options.memory,
    organizationId: options.organizationId,
    timeZone: timeZone(),
    ...(options.brief?.now ? { now: options.brief.now } : {}),
    ...(options.brief?.sync ? { sync: options.brief.sync } : {}),
    ...(options.docs ? { docs: options.docs } : {}),
  });
  return {
    async reason(): Promise<Required<ReasonPass>> {
      const pass = () => reasonNow(options.pipeline, options.memory, options.organizationId);
      const { recommendations, measured, heldBack } = await (options.reason ? options.reason(pass) : pass());
      return { recommendations, measured, heldBack: heldBack ?? [] };
    },
    recommendations: async (limit: number) => ({ recommendations: await options.memory.listRecommendations(options.organizationId, limit) }),
    async value(fromDay: string | null, toDay: string | null) {
      // With no period, the month so far.
      if (fromDay === null && toDay === null) return { report: await readValueReport(options.memory, options.organizationId, monthOf(new Date().toISOString())) };
      const from = dayStart(fromDay ?? "");
      const to = dayStart(toDay ?? "");
      if (Number.isNaN(from) || Number.isNaN(to)) throw new HttpError(400, "from and to must both be days, such as 2026-10-01 and 2026-11-01");
      if (from >= to) throw new HttpError(400, "from must be before to; to is the day after the period");
      if (to - from > MAX_REPORT_DAYS * 86_400_000) throw new HttpError(400, `a report covers at most ${MAX_REPORT_DAYS} days`);
      const period = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
      return { report: await readValueReport(options.memory, options.organizationId, period) };
    },
    async feedback() {
      const policy = options.pipeline.feedbackPolicy;
      // With the loop off, the summary still shows how each rule was treated, by the default policy, and says it's off.
      const feedback = await readFeedbackSummary(options.memory, options.organizationId, new Date().toISOString(), policy ?? DEFAULT_FEEDBACK_POLICY);
      return { feedback: { ...feedback, on: policy !== null } };
    },
    async signals(kinds: string[] | undefined, limit: number) {
      if (kinds && (kinds.length > 10 || kinds.some((k) => !SIGNAL_KIND.test(k)))) {
        throw new HttpError(400, "kind must be up to 10 comma-separated signal kinds, such as bank.balance");
      }
      return { signals: await options.memory.recentSignals(options.organizationId, limit, kinds) };
    },
    async brief(day: string | null) {
      const at = now();
      const date = day ?? yesterdayIn(at, timeZone());
      if (!isDay(date)) throw new HttpError(400, "date must be a day, such as 2026-11-18");
      if (date > localDay(at.getTime(), timeZone())) throw new HttpError(400, "date can't be after today in the store's time zone");
      const brief = await readDailyBrief(
        { memory: options.memory, organizationId: options.organizationId, timeZone: timeZone(), now: () => at, ...(options.brief?.sync ? { sync: options.brief.sync } : {}) },
        date,
      );
      return { brief };
    },
    ask: async (question: unknown) => ({ answer: await readAnswer(askSources(), questionFrom(question)) }),
    /** The passages closest to a query, with where each came from and its score. Read-only. */
    async searchDocs(q: string | null, rawLimit: string | null) {
      if (!options.docs) throw new HttpError(503, "documentation search isn't set up on this instance");
      if (q === null) throw new HttpError(400, "search with ?q=, such as ?q=where+is+the+ups+tracking+file+set");
      const query = q.trim();
      if (!query) throw new HttpError(400, "q can't be empty");
      if ([...query].length > DOC_SEARCH_MAX_QUERY_CHARS) throw new HttpError(400, `q must be at most ${DOC_SEARCH_MAX_QUERY_CHARS} characters`);
      const limit = rawLimit === null ? 5 : Number(rawLimit);
      if (!/^\d+$/.test(rawLimit ?? "5") || limit < 1 || limit > DOC_SEARCH_MAX_RESULTS) {
        throw new HttpError(400, `limit must be a whole number from 1 to ${DOC_SEARCH_MAX_RESULTS}`);
      }
      return { query, embedder: options.docs.embedder, results: await options.docs.search(query, limit) };
    },
    async verify({ system, from, to, toleranceCents }: z.infer<typeof VerifyBody>) {
      if (!options.verify) throw new HttpError(503, "sync verification isn't set up on this instance");
      if (from > to) throw new HttpError(400, "from must be on or before to; both days are included");
      if (to > localDay(now().getTime(), timeZone())) throw new HttpError(400, "to can't be after today in the store's time zone");
      if (addDays(from, VERIFY_MAX_DAYS - 1) < to) throw new HttpError(400, `a verification covers at most ${VERIFY_MAX_DAYS} days`);
      if (system !== undefined && !INTEGRATIONS.some((i) => i.id === system)) throw new HttpError(400, `${system} isn't an integration KaratOS knows`);
      try {
        return { verification: await options.verify.run(verifyPeriod(from, to, timeZone()), { ...(system !== undefined ? { system } : {}), ...(toleranceCents !== undefined ? { toleranceCents } : {}) }) };
      } catch (error) {
        if (error instanceof VerifyBusyError) throw new HttpError(429, error.message);
        throw error;
      }
    },
  };
}

export type BrainOperations = ReturnType<typeof brainOperations>;
