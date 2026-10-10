import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Connector, SourceBatch, SyncContext } from "@karatos/core";
import {
  REDACTED,
  RealLookingDataError,
  SyncCheckError,
  UnrecordedRequestError,
  assertScrubbed,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  findSecret,
  fixtureBuilder,
  hmacSha256,
  loadRecordings,
  normalizeUrl,
  replayFetch,
  scrubRecording,
  synthetic,
  tamper,
  timestampedSignature,
  withFailures,
  type Recording,
} from "../src/index.js";

function event(n: number, key = `k-${n}`) {
  return {
    id: `e-${n}`,
    type: "order.created",
    occurredAt: "2026-01-01T00:00:00Z",
    receivedAt: "2026-01-01T00:00:00Z",
    idempotencyKey: key,
    payload: { n },
  };
}

const PAGES: SourceBatch[] = [
  { events: [event(1), event(2)], cursor: "c1" },
  { events: [event(3)], cursor: "c2" },
];

/** A well-behaved connector over fixed pages, or a broken one for negative tests. */
let generation = 0;

function pagedConnector(pages: SourceBatch[], flaws: { ignoreCursor?: boolean; unstableKeys?: boolean } = {}): Connector {
  const run = ++generation;
  async function* from(context: SyncContext) {
    const start = flaws.ignoreCursor || context.cursor === null ? 0 : pages.findIndex((p) => p.cursor === context.cursor) + 1;
    for (const page of pages.slice(start)) {
      yield flaws.unstableKeys
        ? { ...page, events: page.events.map((e) => ({ ...(e as object), idempotencyKey: `${(e as { idempotencyKey: string }).idempotencyKey}-${run}` })) }
        : page;
    }
  }
  return { source: "paged", historicalImport: from, incrementalSync: from };
}

describe("fixtureBuilder and synthetic values", () => {
  it("numbers records, applies overrides and resets", () => {
    const people = fixtureBuilder((n) => ({ id: n, email: synthetic.email(n), name: synthetic.name(n) }));
    expect(people.one()).toEqual({ id: 1, email: "customer1@example.test", name: "Test Customer 1" });
    expect(people.one({ name: "Override" }).name).toBe("Override");
    expect(people.many(2, (n) => ({ name: `Batch ${n}` })).map((p) => [p.id, p.name])).toEqual([
      [3, "Batch 3"],
      [4, "Batch 4"],
    ]);
    expect(people.many(1)[0]!.id).toBe(5);
    people.reset();
    expect(people.one().id).toBe(1);
  });

  it("produces values that pass assertSynthetic", () => {
    const values = [1, 42, 99].flatMap((n) => [synthetic.email(n), synthetic.phone(n), synthetic.sku(n), synthetic.isoTime(n)]);
    expect(synthetic.phone(7)).toBe("+1 212 555 0107");
    expect(synthetic.sku(7)).toBe("SKU-TEST-0007");
    expect(synthetic.isoTime(2)).toBe("2026-01-01T00:02:00.000Z");
    expect(() => assertSynthetic({ values, nested: [{ n: 1, ok: null }] })).not.toThrow();
  });

  it("catches real-looking emails, card numbers and phone numbers, naming the path", () => {
    expect(() => assertSynthetic({ customer: { email: "jane@gmail.com" } })).toThrow(/\$\.customer\.email/);
    expect(() => assertSynthetic(["note", "card 4242 4242 4242 4242"])).toThrow(RealLookingDataError);
    expect(() => assertSynthetic({ phone: "(212) 867-5309" })).toThrow(/fictional range/);
    expect(() => assertSynthetic({ order: "1234567890123", phone: "+1 212 555 0150", email: "a@shop.test" })).not.toThrow();
  });
});

describe("replayFetch", () => {
  const recordings: Recording[] = [
    { request: { method: "GET", url: "https://api.example/items?b=2&a=1" }, response: { status: 429, body: "slow down" } },
    { request: { method: "GET", url: "https://api.example/items?a=1&b=2" }, response: { status: 200, headers: { etag: "x" }, body: { ok: true } } },
    { request: { method: "post", url: "https://api.example/items" }, response: { status: 204, body: null } },
  ];

  it("answers in recorded order regardless of query order, and tracks calls", async () => {
    const fetch = replayFetch(recordings);
    const first = await fetch("https://api.example/items?a=1&b=2");
    expect([first.status, await first.text()]).toEqual([429, "slow down"]);
    const second = await fetch(new URL("https://api.example/items?b=2&a=1"));
    expect([second.status, second.headers.get("etag"), await second.json()]).toEqual([200, "x", { ok: true }]);
    const third = await fetch(new Request("https://api.example/items", { method: "POST" }));
    expect(third.status).toBe(204);
    expect(fetch.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(fetch.unused()).toEqual([]);
    await expect(fetch("https://api.example/items?a=1&b=2")).rejects.toBeInstanceOf(UnrecordedRequestError);
  });

  it("can let the last recording answer again", async () => {
    const fetch = replayFetch(recordings.slice(1, 2), { reuse: true });
    await fetch("https://api.example/items?a=1&b=2");
    expect((await fetch("https://api.example/items?a=1&b=2")).status).toBe(200);
    expect(replayFetch(recordings).unused()).toHaveLength(3);
  });

  it("normalizes URLs", () => {
    expect(normalizeUrl("https://x.example/p?z=1&a=2")).toBe("https://x.example/p?a=2&z=1");
  });
});

describe("scrubbing recordings", () => {
  const leaky: Recording = {
    request: { method: "get", url: "https://user:pass@api.example/orders?access_token=abc&page=2" },
    response: { status: 200, headers: { "Set-Cookie": "s=1", "x-request-id": "r" }, body: [] },
  };

  it("redacts secret parameters, credentials and headers", () => {
    expect(findSecret(leaky)).toBe("credentials in the URL");
    const clean = scrubRecording(leaky);
    expect(clean.request).toEqual({ method: "GET", url: `https://api.example/orders?access_token=${REDACTED}&page=2` });
    expect(clean.response.headers).toEqual({ "x-request-id": "r" });
    expect(findSecret(clean)).toBeNull();
    expect(scrubRecording({ ...clean, response: { status: 200, body: 1 } }).response.headers).toEqual({});
  });

  it("refuses recordings that still hold a secret, without echoing it", () => {
    const token: Recording = { request: { method: "GET", url: "https://api.example/o?token=abc" }, response: { status: 200, body: 1 } };
    expect(findSecret(token)).toBe("query parameter token");
    expect(() => assertScrubbed([token])).toThrow(/https:\/\/api\.example\/o holds query parameter token/);
    expect(() => assertScrubbed([token])).not.toThrow(/abc/);
    const header: Recording = { ...token, request: { method: "GET", url: "https://api.example/o" }, response: { status: 200, headers: { authorization: "x" }, body: 1 } };
    expect(findSecret(header)).toBe("response header authorization");
  });

  it("loads recordings from disk only when they are well formed and clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recordings-"));
    const good = join(dir, "good.json");
    await writeFile(good, JSON.stringify([scrubRecording(leaky)]));
    expect(await loadRecordings(good)).toHaveLength(1);
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify([{ request: { method: "GET" }, response: { status: 200, body: 1 } }]));
    await expect(loadRecordings(bad)).rejects.toThrow(/not a list of recordings/);
    const notList = join(dir, "obj.json");
    await writeFile(notList, JSON.stringify({ request: 1 }));
    await expect(loadRecordings(notList)).rejects.toThrow(/not a list/);
    const odd = join(dir, "odd.json");
    await writeFile(odd, JSON.stringify([null, { request: null, response: {} }]));
    await expect(loadRecordings(odd)).rejects.toThrow(/not a list/);
    const leaking = join(dir, "leak.json");
    await writeFile(leaking, JSON.stringify([leaky]));
    await expect(loadRecordings(leaking)).rejects.toThrow(/scrub it first/);
  });
});

describe("checkConnectorSync", () => {
  it("passes a well-behaved connector through every scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => pagedConnector(PAGES), expected: { ingested: 3 } });
    expect(result.full).toMatchObject({ ingested: 3, batches: 2, cursor: "c2" });
    expect(result.replay).toMatchObject({ ingested: 0, duplicates: 3 });
    expect(result.resume).toMatchObject({ ingested: 1, duplicates: 0, cursor: "c2" });
    expect(result.retry).toMatchObject({ ingested: 3, duplicates: 0 });
  });

  it("skips the resume scenario for a single-batch source and supports incremental mode", async () => {
    const result = await checkConnectorSync({
      makeConnector: () => pagedConnector(PAGES.slice(0, 1)),
      mode: "incremental",
      expected: { ingested: 2 },
    });
    expect(result.resume).toBeNull();
  });

  it("reports a connector that ignores its checkpoint", async () => {
    const check = checkConnectorSync({ makeConnector: () => pagedConnector(PAGES, { ignoreCursor: true }), expected: { ingested: 3 } });
    await expect(check).rejects.toThrow(/ignores the checkpoint cursor/);
  });

  it("reports unstable idempotency keys and wrong counts together", async () => {
    const error = await checkConnectorSync({
      makeConnector: () => pagedConnector(PAGES, { unstableKeys: true }),
      expected: { ingested: 5, deadLettered: 1 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncCheckError);
    const failures = (error as SyncCheckError).failures.join("\n");
    expect(failures).toMatch(/full import ingested 3, expected 5/);
    expect(failures).toMatch(/dead-lettered 0, expected 1/);
    expect(failures).toMatch(/idempotency keys aren't stable/);
  });

  it("reports duplicates inside fresh data and a retry that doubles data", async () => {
    const dup: SourceBatch[] = [{ events: [event(1), event(2, "k-1")], cursor: "c1" }];
    const failures = await checkConnectorSync({ makeConnector: () => pagedConnector(dup), expected: { ingested: 1 } }).catch(
      (e: SyncCheckError) => e.failures,
    );
    expect(failures).toEqual(expect.arrayContaining([expect.stringMatching(/1 duplicates in fresh data/)]));
  });

  it("reports a connector that swallows source failures instead of surfacing them", async () => {
    const swallowing = (): Connector => {
      const inner = pagedConnector(PAGES);
      return {
        ...inner,
        historicalImport: async function* (context) {
          try {
            yield* withFailures(inner, { beforeBatch: 1, times: 99 }).historicalImport(context);
          } catch {
            return;
          }
        },
      };
    };
    const failures = await checkConnectorSync({ makeConnector: swallowing, expected: { ingested: 3 } }).catch(
      (e: SyncCheckError) => e.failures,
    );
    expect(failures).toEqual(expect.arrayContaining([expect.stringMatching(/full import ingested 2/)]));
  });

  it("rethrows errors that aren't injected outages", async () => {
    const broken = (): Connector => ({
      source: "broken",
      historicalImport: async function* () {
        yield PAGES[0]!;
        yield PAGES[1]!;
      },
      incrementalSync: async function* () {
        yield* [];
      },
    });
    let runs = 0;
    const exploding = (): Connector => {
      runs++;
      const connector = broken();
      if (runs !== 3) return connector;
      return {
        ...connector,
        historicalImport: async function* () {
          yield PAGES[0]!;
          throw new TypeError("bug in connector");
        },
      };
    };
    await expect(checkConnectorSync({ makeConnector: exploding, expected: { ingested: 3 } })).rejects.toThrow(/bug in connector/);
  });
});

describe("webhook signing", () => {
  it("signs bodies the way vendors do", () => {
    expect(hmacSha256("secret", "{}")).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacSha256("secret", "{}", "base64")).toMatch(/=$/);
    expect(timestampedSignature("secret", "{}", 1700000000)).toBe(`t=1700000000,v1=${hmacSha256("secret", "1700000000.{}")}`);
  });

  it("tampers with exactly one character", () => {
    expect(tamper('{"a":1}')).toBe('{"a":1~'.replace("~", String.fromCharCode("}".charCodeAt(0) + 1)));
    expect(tamper("z")).toBe("y");
    expect(tamper("")).toBe(" ");
  });
});

describe("assertWritesRefused", () => {
  it("passes a read-only connector with no writes", async () => {
    expect(await assertWritesRefused(pagedConnector(PAGES))).toEqual([]);
  });

  it("rejects a write declared for another integration", async () => {
    const connector = { ...pagedConnector(PAGES), writes: [{ integration: "other", name: "x", description: "x" }] };
    await expect(assertWritesRefused(connector)).rejects.toThrow(/declared for other, not paged/);
  });
});
