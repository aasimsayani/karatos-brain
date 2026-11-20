import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore } from "@karatos/core";
import { ASK_MAX_QUESTION_CHARS, combineDepartments, RETAIL_DEPARTMENTS, type AskAnswer } from "@karatos/retail";
import { ASK_MAX_BODY_BYTES, ASK_MAX_SOURCE_LOOKUPS, createBrainApp, readAnswer, StaticDocumentationSource } from "../src/index.js";

const ORG = "example-jewelers";
const TZ = "America/New_York";
// Friday 2026-11-20, 10:00 in New York.
const NOW = "2026-11-20T15:00:00.000Z";
const newKey = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const INSTANCE_KEY = newKey("i");
const SUPPORT_KEY = newKey("s");

/** An instance with every retail department, fed only made-up records. */
function brain() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: new StaticDocumentationSource([]), now: () => new Date(NOW) });
  let n = 0;
  const send = (source: string, type: string, payload: Record<string, unknown>, occurredAt: string) => {
    n++;
    return pipeline.ingest({ id: `evt_${source}_${n}`, organizationId: ORG, source, type, occurredAt, receivedAt: occurredAt, idempotencyKey: `${source}:${type}:${n}`, payload });
  };
  const sale = (source: string, occurredAt: string, totalCents: number, channel = "store") =>
    send(source, "sale.completed", { saleId: `S${n + 1}`, channel, totalCents, lines: [{ sku: "R1", quantity: 1, unitPriceCents: totalCents }], payments: [{ method: "card", amountCents: totalCents }] }, occurredAt);
  const sources = { memory, organizationId: ORG, timeZone: TZ, now: () => new Date(NOW) };
  return { memory, pipeline, send, sale, sources, ask: (q: string) => readAnswer(sources, q) };
}

/** Sales, a late payout, two stock counts that disagree and a text nobody answered, then one reasoning run. */
async function stocked() {
  const b = brain();
  await b.sale("shopify", "2026-11-16T15:00:00Z", 12_000, "online"); // Monday
  await b.sale("square", "2026-11-19T04:30:00Z", 30_000); // 23:30 on Wednesday the 18th in New York
  await b.sale("square", "2026-11-14T15:00:00Z", 99_900); // the Saturday before: not this week
  await b.send("stripe", "payout.updated", { payoutId: "stripe:payout:po_late", amountCents: 20_000, currency: "usd", status: "pending", arrivalDate: "2026-11-10" }, "2026-11-08T12:00:00Z");
  await b.send("katana", "inventory.counted", { sku: "R-1", onHand: 5 }, "2026-11-20T12:00:00Z");
  await b.send("cin7", "inventory.counted", { sku: "R-1", onHand: 2 }, "2026-11-20T12:00:00Z");
  await b.send("twilio", "communication.message_logged", { system: "twilio", channel: "sms", messageId: "twilio:message:1", direction: "inbound", customerRefs: ["form_customer:waiting"] }, "2026-11-18T15:00:00.000Z");
  await b.pipeline.reason(ORG);
  return b;
}

describe("readAnswer", () => {
  it("answers each kind of question from synced events, every number citing events and the systems that sent them", async () => {
    const b = await stocked();
    const events = new Map(b.memory.events.map((e) => [e.id, e.source]));
    const cited = (a: AskAnswer) => {
      expect(a.status, a.question).toBe("answered");
      expect(a.facts.length, a.question).toBeGreaterThan(0);
      for (const f of a.facts) {
        expect(f.citation.eventIds.length, f.label).toBeGreaterThan(0);
        expect(f.citation.systems, f.label).toEqual([...new Set(f.citation.eventIds.map((id) => events.get(id)!))].sort());
      }
    };

    const sales = await b.ask("What sold this week?");
    cited(sales);
    expect(sales.sales!.totals).toMatchObject({ sales: 2, grossCents: 42_000, saleEvents: { eventIds: ["evt_shopify_1", "evt_square_2"], systems: ["shopify", "square"] } });
    expect(sales.text).toContain("This week (2026-11-16 to 2026-11-20): 2 sales, $420.00 gross [events evt_shopify_1, evt_square_2; shopify, square]; no refunds.");

    const payouts = await b.ask("Which payouts are late?");
    cited(payouts);
    expect(payouts.findings.map((f) => [f.kind, f.systems, f.eventIds])).toEqual([["pending", ["stripe"], ["evt_stripe_4"]]]);
    expect(payouts.text).toContain("Stripe payout po_late of $200.00 from 2026-11-08 still shows as pending");

    const stock = await b.ask("What's low on stock?");
    cited(stock);
    expect(stock.findings.map((f) => [f.kind, f.systems])).toEqual([["disagree", ["cin7", "katana"]]]);

    const waiting = await b.ask("Who is waiting on a reply?");
    cited(waiting);
    expect(waiting.findings.map((f) => [f.kind, f.systems])).toEqual([["awaiting_reply", ["twilio"]]]);

    const open = await b.ask("What's waiting on me?");
    cited(open);
    expect(open.findings.length).toBeGreaterThanOrEqual(3);
  });

  it("reads days on the store's clock: a sale late on Wednesday night is Wednesday's", async () => {
    const b = await stocked();
    expect((await b.ask("sales on 2026-11-18")).sales!.totals.saleEvents.eventIds).toEqual(["evt_square_2"]);
    expect((await b.ask("sales on 2026-11-19")).status).toBe("answered");
    expect((await b.ask("sales on 2026-11-19")).facts).toEqual([]);
    const kolkata = await readAnswer({ ...b.sources, timeZone: "Asia/Kolkata" }, "sales on 2026-11-19");
    expect(kolkata.sales!.totals.saleEvents.eventIds).toEqual(["evt_square_2"]);
  });

  it("says nothing has synced, never zeros, on an empty instance", async () => {
    const b = brain();
    for (const q of ["What sold this week?", "Which payouts are late?", "What's low on stock?", "Who is waiting on a reply?", "What's waiting on me?", "Is everything syncing?"]) {
      const a = await b.ask(q);
      expect(a.status, q).toBe("no_data");
      expect(a.facts, q).toEqual([]);
      expect(a.text, q).not.toMatch(/\$0\.00|\b0 (sales|findings|recommendations)/);
    }
  });

  it("answers sync health from the sync runner's results", async () => {
    const b = brain();
    const a = await readAnswer({ ...b.sources, sync: () => ({ scheduled: ["shopify"], statuses: [{ id: "shopify", outcome: "failed", finishedAt: NOW, error: "timeout" }], skipped: [] }) }, "is everything syncing?");
    expect(a.text).toContain("- shopify last sync failed: timeout");
  });

  it("looks up at most ASK_MAX_SOURCE_LOOKUPS events to cite findings, still listing every event id", async () => {
    const b = brain();
    const eventIds = Array.from({ length: ASK_MAX_SOURCE_LOOKUPS + 20 }, (_, i) => `evt_missing_${i}`);
    await b.memory.saveRecommendations([{ id: "rec_repairs_x_2026-11-20", organizationId: ORG, summary: "s", confidence: 0.5, expectedImpact: "x", provenance: { eventIds, signalIds: [], documentIds: [] }, degraded: false, createdAt: "2026-11-20T14:00:00.000Z" }]);
    let lookups = 0;
    const getEvent = b.memory.getEvent.bind(b.memory);
    b.memory.getEvent = (org, id) => {
      lookups++;
      return getEvent(org, id);
    };
    const a = await b.ask("what's waiting on me");
    expect(lookups).toBe(ASK_MAX_SOURCE_LOOKUPS);
    expect(a.findings[0]!.eventIds).toHaveLength(eventIds.length);
    expect(a.findings[0]!.systems).toEqual([]);
    expect(a.facts).toEqual([]);
  });

  it("only reads: nothing is ingested, reasoned, saved or recorded", async () => {
    const b = await stocked();
    const before = JSON.stringify({ e: b.memory.events, r: b.memory.recommendations, runs: b.memory.reasoningRuns, f: b.memory.feedback, s: b.memory.signals });
    for (const q of ["what sold this week", "which payouts are late", "what's low on stock", "who is waiting on a reply", "what's waiting on me", "is everything syncing", "what's the weather"]) await b.ask(q);
    expect(JSON.stringify({ e: b.memory.events, r: b.memory.recommendations, runs: b.memory.reasoningRuns, f: b.memory.feedback, s: b.memory.signals })).toBe(before);
  });
});

describe("/v1/ask", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function start() {
    const b = await stocked();
    server = createServer(createBrainApp({ pipeline: b.pipeline, memory: b.memory, organizationId: ORG, apiKey: INSTANCE_KEY, supportApiKey: SUPPORT_KEY, brief: { timeZone: TZ, now: () => new Date(NOW) } }));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const call = (path: string, init: RequestInit = {}, key: string | null = INSTANCE_KEY) =>
      fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
    const post = (body: string, key: string | null = INSTANCE_KEY) => call("/v1/ask", { method: "POST", body }, key);
    return { ...b, base, call, post };
  }

  it("answers a question asked with GET ?q= or POST {question}, the same way", async () => {
    const { call, post } = await start();
    const viaGet = await call(`/v1/ask?q=${encodeURIComponent("What sold this week?")}`);
    expect(viaGet.status).toBe(200);
    expect(viaGet.headers.get("cache-control")).toBe("no-store");
    const viaPost = await post(JSON.stringify({ question: "  What sold this week?  " }));
    expect(viaPost.status).toBe(200);
    const [a, b] = [((await viaGet.json()) as { answer: AskAnswer }).answer, ((await viaPost.json()) as { answer: AskAnswer }).answer];
    expect(a).toEqual(b);
    expect(a).toMatchObject({ question: "What sold this week?", intent: "sales", status: "answered", timeZone: TZ, generatedAt: NOW });
  });

  it("answers an unsupported question with 200 and the list of what it can answer", async () => {
    const { post } = await start();
    const res = await post(JSON.stringify({ question: "what's the weather?" }));
    expect(res.status).toBe(200);
    const { answer } = (await res.json()) as { answer: AskAnswer };
    expect(answer.status).toBe("unsupported");
    expect(answer.canAnswer!.length).toBeGreaterThan(0);
  });

  it("turns down questions that are missing, empty, not text or too long", async () => {
    const { call, post } = await start();
    const cases: [Promise<Response>, string][] = [
      [call("/v1/ask"), "ask with ?q=, such as ?q=what+sold+this+week"],
      [call("/v1/ask?q=%20%20"), "question can't be empty"],
      [call(`/v1/ask?q=${"a".repeat(ASK_MAX_QUESTION_CHARS + 1)}`), `question must be at most ${ASK_MAX_QUESTION_CHARS} characters`],
      [post(JSON.stringify({ question: "" })), "question can't be empty"],
      [post(JSON.stringify({ question: "a".repeat(ASK_MAX_QUESTION_CHARS + 1) })), `question must be at most ${ASK_MAX_QUESTION_CHARS} characters`],
      [post(JSON.stringify({ question: 42 })), 'the body must be a JSON object with a question, such as {"question": "what sold this week?"}'],
      [post(JSON.stringify({ q: "sales" })), 'the body must be a JSON object with a question, such as {"question": "what sold this week?"}'],
      [post(JSON.stringify(["sales"])), 'the body must be a JSON object with a question, such as {"question": "what sold this week?"}'],
      [post("{not json"), "request body must be JSON"],
      [post(""), "request body must be JSON"],
    ];
    for (const [res, error] of cases) {
      const r = await res;
      expect(r.status, error).toBe(400);
      expect(await r.json()).toEqual({ error });
    }
    // Exactly the limit is fine, counted in characters, not bytes.
    expect((await post(JSON.stringify({ question: "é".repeat(ASK_MAX_QUESTION_CHARS) }))).status).toBe(200);
    expect((await call(`/v1/ask?q=${encodeURIComponent("é".repeat(ASK_MAX_QUESTION_CHARS))}`)).status).toBe(200);
  });

  it("turns down a body over ASK_MAX_BODY_BYTES with 413", async () => {
    const { post } = await start();
    const res = await post(JSON.stringify({ question: "sales", padding: "x".repeat(ASK_MAX_BODY_BYTES) }));
    expect(res.status).toBe(413);
  });

  it("needs the instance key: none or a wrong one is 401, the support key is 403 and sees no data", async () => {
    const { call, post } = await start();
    for (const key of [null, newKey("x")]) {
      expect((await call("/v1/ask?q=sales", {}, key)).status).toBe(401);
      expect((await post(JSON.stringify({ question: "sales" }), key)).status).toBe(401);
    }
    for (const res of [await call("/v1/ask?q=what+sold+this+week", {}, SUPPORT_KEY), await post(JSON.stringify({ question: "what sold this week" }), SUPPORT_KEY)]) {
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).not.toContain("evt_");
      expect(body).not.toContain("420");
    }
  });

  it("turns the support key down before reading the body", async () => {
    const { base } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/v1/ask`, { method: "POST", headers: { authorization: `Bearer ${SUPPORT_KEY}`, "content-type": "application/json", "content-length": "1000" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", reject);
      req.write("{");
    });
    expect(status).toBe(403);
  });

  it("only answers GET and POST", async () => {
    const { call } = await start();
    for (const method of ["PUT", "DELETE", "PATCH"]) expect((await call("/v1/ask", { method }, INSTANCE_KEY)).status, method).toBe(405);
  });

  it("uses New York days without brief options", async () => {
    const b = brain();
    server = createServer(createBrainApp({ pipeline: b.pipeline, memory: b.memory, organizationId: ORG, apiKey: INSTANCE_KEY }));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const res = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/ask?q=is+everything+syncing`, { headers: { authorization: `Bearer ${INSTANCE_KEY}` } });
    const { answer } = (await res.json()) as { answer: AskAnswer };
    expect(answer.timeZone).toBe("America/New_York");
    expect(answer.status).toBe("no_data");
  });
});
