import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import {
  DOC_MOCK_MODULES,
  JM_SHIPPING_DOC_PAGES,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  checkConnectorSync,
  jmShippingBoughtAt,
  jmShippingClaim,
  jmShippingDocMock,
  jmShippingGidOf,
  jmShippingReconciled,
  jmShippingShipment,
  jmShippingTracking,
  jmShippingTrackingOf,
  testPipeline,
  type JmShippingMock,
  type JmShippingMockData,
  type JmShippingMockRecord,
} from "@karatos/connector-testkit";
import {
  JM_CARGO,
  JM_CLAIM_EVENT,
  JM_CLAIM_STATUSES,
  JM_RECONCILED_EVENT,
  JM_SHIPMENT_EVENT,
  JM_SHIPPING_HISTORY_YEARS,
  JM_SHIPPING_IDS_PER_REQUEST,
  JM_SHIPPING_REVISIT_DAYS,
  JM_SHIPPING_UAT_BASE,
  JM_SHIPPING_USER_AGENT,
  JM_SHIPPING_WINDOW_DAYS,
  JM_SHIPPING_WRITES,
  JM_TRACKING,
  JM_TRACKING_EVENT,
  JmShippingApiError,
  JmShippingConfigError,
  WHATNOT_USER_AGENT,
  isJmShippingDay,
  isJmShippingGid,
  jmClaimEvent,
  jmReconciledEvent,
  jmShipmentEvent,
  jmShippingBase,
  jmShippingCents,
  jmShippingClient,
  jmShippingConnector,
  jmShippingErrors,
  jmShippingGid,
  jmShippingId,
  jmShippingOne,
  jmShippingRef,
  jmShippingReference,
  jmShippingSignedCents,
  jmShippingTime,
  jmShippingTrackingNumber,
  jmShippingUnlisted,
  jmTrackingEvent,
  parseJmShippingCursor,
  JM_CARRIERS,
  JM_SERVICES,
  type JmShipmentFacts,
  type JmShippingCursor,
  type JmShippingEvent,
  type JmShippingOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["0a1b2c3d", "4e5f", "4a6b", "8c7d", "9e0f1a2b3c4d"].join("-");
const PASSWORD = ["test", "p".repeat(12)].join("-");
const BASIC = `Basic ${Buffer.from(`${KEY}:${PASSWORD}`).toString("base64")}`;
const CLIENT = "4321";
const NOW = () => new Date("2026-11-12T15:30:00.000Z");
const RECEIVED = "2026-11-12T15:30:00.000Z";
const noSleep = async () => {};
const SETTINGS = "JM_SHIPPING_API_KEY and JM_SHIPPING_PASSWORD must be the key and password JM issued the store, for the host in JM_SHIPPING_API_BASE";
const gid = jmShippingGidOf;
const ref = (n: number) => jmShippingRef("shipment", gid(n));

const obj = (v: unknown) => v as Record<string, unknown>;
const after = (n: number, hours: number) => new Date(Date.parse(jmShippingBoughtAt(n)) + hours * 3_600_000).toISOString();
/** Shipment `n`, with its own ids and times whatever the builder's count, and fields of its Shipment replaced. */
const shipment = (n: number, fields: Record<string, unknown> = {}, outer: Record<string, unknown> = {}): JmShippingMockRecord => {
  const s = jmShippingShipment.one();
  const purchase = Object.hasOwn(outer, "Purchase") ? outer.Purchase : { ...obj(s.Purchase), Id: 80000 + n, Gid: gid(n), TrackingNumber: jmShippingTrackingOf(n) };
  const times = { TransactionTime: jmShippingBoughtAt(n), ShipDate: jmShippingBoughtAt(n), CarrierShipDate: jmShippingBoughtAt(n), CarrierDeliveryDate: after(n, 48) };
  return { ...s, ...outer, Shipment: { ...obj(s.Shipment), Id: 70000 + n, Gid: gid(n), TrackingNumber: jmShippingTrackingOf(n), Reference1: `ORD-${n}`, ...times, ...fields }, Purchase: purchase };
};
const activity = (n: number, hours: number, code: number, description: string, carrier: string) => ({
  activityDescription: description,
  carrierActivityCode: carrier,
  tgActivityCode: code,
  activityCity: "Test City",
  activityState: "CA",
  activityZip: "90001",
  activityCountry: "US",
  activityDate: after(n, hours).slice(0, 10),
  activityTime: after(n, hours).slice(11, 19),
  activityDateTime: after(n, hours),
});
/** Shipment `n`'s tracking, as jmShippingTracking gives it: enroute an hour after it was bought, out for delivery a day later. */
const tracking = (n: number, fields: Record<string, unknown> = {}): JmShippingMockRecord => ({
  Activities: [activity(n, 1, 80, "Departed facility", "DP"), activity(n, 25, 89, "Out for delivery", "OT")],
  TrackingNumber: jmShippingTrackingOf(n),
  Id: 70000 + n,
  Gid: gid(n),
  ZingId: `zing-${n}`,
  Error: null,
  Status: 1,
  ...fields,
});
const claim = (n: number, fields: Record<string, unknown> = {}): JmShippingMockRecord => ({
  ...jmShippingClaim.one(),
  Id: 90000 + n,
  ShipmentId: 70000 + n,
  ShipmentGid: gid(n),
  TrackingNumber: jmShippingTrackingOf(n),
  ShipDate: jmShippingBoughtAt(n),
  ClaimFiledOn: after(n, 5 * 24),
  ClaimDueDate: after(n, 60 * 24),
  ...fields,
});
const reconciled = (n: number, fields: Record<string, unknown> = {}): JmShippingMockRecord => ({
  ...jmShippingReconciled.one(),
  ShipmentId: 70000 + n,
  ShipmentGid: gid(n),
  TrackingNumber: jmShippingTrackingOf(n),
  PurchasedOn: jmShippingBoughtAt(n),
  ReconciledOn: after(n, 7 * 24),
  InvoiceReference: `INV-TEST-${n}`,
  ...fields,
});

/**
 * Twelve shipments bought six hours apart from October 1, 2026: shipment 3
 * voided and shipment 4 only saved. Each has tracking; 2, 3 and 5 have a
 * claim (3's is never asked for, being voided); 1 to 3 were reconciled.
 */
function store(overrides: Partial<JmShippingMockData> = {}): JmShippingMockData {
  for (const b of [jmShippingShipment, jmShippingTracking, jmShippingClaim, jmShippingReconciled]) b.reset();
  const n12 = Array.from({ length: 12 }, (_, i) => i + 1);
  const shipments = n12.map((n) => (n === 3 ? shipment(3, { VoidedOn: "2026-10-02T12:00:00.000Z", VoidId: 5 }) : n === 4 ? shipment(4, {}, { ShipmentStatus: 0 }) : shipment(n)));
  return {
    apiKey: KEY,
    password: PASSWORD,
    shipments,
    tracking: n12.map((n) => tracking(n)),
    claims: [claim(2), claim(3), claim(5)],
    reconciled: [reconciled(1), reconciled(2), reconciled(3)],
    ...overrides,
  };
}

const connector = (mock: JmShippingMock, overrides: Partial<JmShippingOptions> = {}) =>
  jmShippingConnector({ apiKey: KEY, password: PASSWORD, clientId: CLIENT, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as JmShippingEvent[];
const API = "/api/v1";

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const plain = (status: number, text: string) => () => new Response(text, { status });
const LIST = json(200, { Error: null, ShipmentGids: [gid(1)] });
const client = (fetch: typeof globalThis.fetch, slept: number[] = [], more: Record<string, unknown> = {}) => jmShippingClient({ apiKey: KEY, password: PASSWORD, clientId: CLIENT, fetch, sleep: async (ms) => void slept.push(ms), ...more });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);
const thrown = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return e as Error;
  }
};

describe("JM Shipping Solution client", () => {
  it("checks the key, password, client id and host before sending anything, and never echoes them", () => {
    const { fetch, sent } = scripted(LIST);
    const make = (o: Record<string, unknown>) => thrown(() => jmShippingClient({ apiKey: KEY, password: PASSWORD, clientId: CLIENT, fetch, ...o }));
    const keyMessage = new JmShippingConfigError("set JM_SHIPPING_API_KEY to the key JM issued the store, a GUID such as 00000000-0000-0000-0000-000000000000");
    for (const bad of ["", "  ", KEY.slice(1), `${KEY}0`, KEY.replace(/-/g, ""), KEY.replace("a", "g"), `{${KEY}}`]) {
      const error = make({ apiKey: bad });
      expect(error, bad).toEqual(keyMessage);
    }
    const passwordMessage = new JmShippingConfigError("set JM_SHIPPING_PASSWORD to the password JM issued with the key: 1 to 256 printable ASCII characters");
    for (const bad of ["", "   ", "x".repeat(257), "pässword", "tab\there"]) expect(make({ password: bad }), bad).toEqual(passwordMessage);
    const clientMessage = new JmShippingConfigError("set JM_SHIPPING_CLIENT_ID to the store's JM client id, a whole number from 1 to 9999999999");
    for (const bad of ["", "0", "01", "-1", "1.5", "abc", "12345678901"]) expect(make({ clientId: bad }), bad).toEqual(clientMessage);
    for (const good of [{ apiKey: ` ${KEY.toUpperCase()} ` }, { password: "x" }, { password: "x".repeat(256) }, { password: " with spaces inside " }, { clientId: "1" }, { clientId: " 9999999999 " }]) expect(make(good), JSON.stringify(good)).toBeNull();
    expect(make({ apiBase: "http://uat2.transguardian.com" })?.message).toMatch(/^JM_SHIPPING_API_BASE must be/);
    expect(sent).toEqual([]);
    const e = make({ apiKey: `${KEY}0` });
    expect(e?.message).not.toContain(`${KEY}0`);
    expect(make({ password: "x".repeat(257) })?.message).not.toContain("x".repeat(257));
    expect(JM_SHIPPING_USER_AGENT).toBe(WHATNOT_USER_AGENT);
    expect(new JmShippingConfigError("x").name).toBe("JmShippingConfigError");
    expect(new JmShippingApiError("x", 0).name).toBe("JmShippingApiError");
  });

  it("only sends credentials to an https host on transguardian.com", () => {
    expect(jmShippingBase(undefined)).toBe(JM_SHIPPING_UAT_BASE);
    expect(jmShippingBase("  ")).toBe("https://uat2.transguardian.com");
    for (const good of ["https://uat2.transguardian.com", "https://uat2.transguardian.com/", " https://API.TransGuardian.com ", "https://transguardian.com", "https://uat2.transguardian.com:443"]) expect(jmShippingBase(good), good).toMatch(/^https:\/\/[a-z0-9.]*transguardian\.com$/);
    expect(jmShippingBase("https://API.TransGuardian.com/")).toBe("https://api.transguardian.com");
    expect(jmShippingBase("https://uat2.transguardian.com:8443")).toBe("https://uat2.transguardian.com:8443");
    const message = "JM_SHIPPING_API_BASE must be the https address of a JM Shipping Solution host on transguardian.com, such as https://uat2.transguardian.com, with no path";
    for (const bad of [
      "uat2.transguardian.com",
      "http://uat2.transguardian.com",
      "https://transguardian.com.example.test",
      "https://eviltransguardian.com",
      "https://example.test/transguardian.com",
      "https://uat2.transguardian.com/api",
      "https://uat2.transguardian.com/?x=1",
      "https://uat2.transguardian.com/#x",
      "https://user:pw@uat2.transguardian.com",
      "https://user@uat2.transguardian.com",
      "not a url",
    ]) {
      expect(thrown(() => jmShippingBase(bad)), bad).toEqual(new JmShippingConfigError(message));
    }
  });

  it("sends only GETs to the documented paths, with the key, basic credentials and User-Agent in headers", async () => {
    const { fetch, sent } = scripted(LIST, json(200, [{ a: 1 }]), json(200, [{ b: 2 }]), json(200, { Claim: { Id: 1 }, Error: null }), json(200, [{ c: 3 }]));
    const c = jmShippingClient({ apiKey: ` ${KEY} `, password: ` ${PASSWORD} `, clientId: ` ${CLIENT} `, fetch, sleep: noSleep, apiBase: "https://api.transguardian.com/" });
    expect(await c.shipmentGids("2026-11-01", "2026-11-08")).toEqual([gid(1)]);
    expect(await c.shipments([gid(1), gid(2)])).toEqual([{ a: 1 }]);
    expect(await c.tracking([gid(1)])).toEqual([{ b: 2 }]);
    expect(await c.claim(gid(1).toUpperCase())).toEqual({ Claim: { Id: 1 }, Error: null });
    expect(await c.reconciled("2026-11-01", "2026-11-01")).toEqual([{ c: 3 }]);
    expect(sent.map((s) => s.url)).toEqual([
      `https://api.transguardian.com${API}/shipment/list/4321/2026-11-01/2026-11-08`,
      `https://api.transguardian.com${API}/shipment/${gid(1)},${gid(2)}`,
      `https://api.transguardian.com${API}/shipment/track/latest/${gid(1)}`,
      `https://api.transguardian.com${API}/claim/${gid(1).toUpperCase()}`,
      `https://api.transguardian.com${API}/shipment/reconciliation/4321/2026-11-01/2026-11-01`,
    ]);
    for (const s of sent) {
      expect(s.method).toBe("GET");
      expect(s.headers).toEqual({ accept: "application/json", authorization: BASIC, API_KEY: KEY, "user-agent": JM_SHIPPING_USER_AGENT });
      expect(s.url).not.toContain("?");
      expect(s.url).not.toContain(PASSWORD);
    }
    const uat = scripted(LIST);
    await client(uat.fetch).shipmentGids("2026-11-01", "2026-11-02");
    expect(uat.sent[0]!.url).toBe(`https://uat2.transguardian.com${API}/shipment/list/4321/2026-11-01/2026-11-02`);
  });

  it("checks days and GUIDs before sending them", async () => {
    const { fetch, sent } = scripted(json(200, []));
    const c = client(fetch);
    const range = new JmShippingApiError("a date range must be two YYYY-MM-DD days, the first not after the second", 0);
    for (const [from, to] of [
      ["2026-11-02", "2026-11-01"],
      ["2026-02-30", "2026-03-01"],
      ["2026-1-01", "2026-01-02"],
      ["2026-11-01", "2026-11-01T00:00:00Z"],
      ["", "2026-11-01"],
    ] as const) {
      expect(await failure(c.shipmentGids(from, to)), `${from} ${to}`).toEqual(range);
      expect(await failure(c.reconciled(from, to)), `${from} ${to}`).toEqual(range);
    }
    const idMessage = new JmShippingApiError(`a request takes 1 to ${JM_SHIPPING_IDS_PER_REQUEST} shipment GUIDs JM gave`, 0);
    const twentyOne = Array.from({ length: 21 }, (_, i) => gid(i + 1));
    for (const ids of [[], twentyOne, ["70001"], [gid(1), "x"], [`${gid(1)},${gid(2)}`]]) {
      expect(await failure(c.shipments(ids)), ids.join()).toEqual(idMessage);
      expect(await failure(c.tracking(ids)), ids.join()).toEqual(idMessage);
    }
    for (const id of ["70001", "", `${gid(1)}/x`]) expect(await failure(c.claim(id)), id).toEqual(new JmShippingApiError("a claim is read by a shipment GUID JM gave", 0));
    expect(sent).toEqual([]);
    expect(JM_SHIPPING_IDS_PER_REQUEST).toBe(20);
    await c.shipments(twentyOne.slice(0, 20));
    await c.reconciled("2024-02-29", "2024-02-29");
    expect(sent).toHaveLength(2);
    expect(isJmShippingDay("2024-02-29")).toBe(true);
    expect(isJmShippingDay("2025-02-29")).toBe(false);
    expect(isJmShippingDay(20260101)).toBe(false);
    expect(isJmShippingGid(gid(1))).toBe(true);
    expect(isJmShippingGid(gid(1).toUpperCase())).toBe(true);
    expect(isJmShippingGid(` ${gid(1)}`)).toBe(false);
    expect(isJmShippingGid(1)).toBe(false);
  });

  it("retries a 429 or 5xx, waiting as Retry-After says up to a minute, else 1, 2 and 4 seconds", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const slept: number[] = [];
      const { fetch, sent } = scripted(json(status, {}), json(status, {}), json(status, {}), LIST);
      expect(await client(fetch, slept).shipmentGids("2026-11-01", "2026-11-02"), String(status)).toEqual([gid(1)]);
      expect(slept, String(status)).toEqual([1000, 2000, 4000]);
      expect(sent).toHaveLength(4);
    }
    for (const [after, wait] of [
      ["1", 1000],
      ["60", 60_000],
      ["61", 60_000],
      ["3600", 60_000],
      ["0", 1000],
      ["-5", 1000],
      ["1.5", 1000],
      ["soon", 1000],
    ] as const) {
      const slept: number[] = [];
      const { fetch } = scripted(json(429, {}, { "retry-after": after }), LIST);
      await client(fetch, slept).shipmentGids("2026-11-01", "2026-11-02");
      expect(slept, after).toEqual([wait]);
    }
  });

  it("gives up after three retries, and doesn't retry other errors", async () => {
    const slept: number[] = [];
    const { fetch, sent } = scripted(json(503, { Message: "Down for maintenance" }));
    expect(await failure(client(fetch, slept).shipmentGids("2026-11-01", "2026-11-02"))).toEqual(new JmShippingApiError("JM Shipping Solution answered HTTP 503 for the shipment list: Down for maintenance", 503));
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 4000]);
    const once = scripted(json(503, {}), LIST);
    expect(await failure(client(once.fetch, [], { retries: 0 }).shipmentGids("2026-11-01", "2026-11-02"))).toEqual(new JmShippingApiError("JM Shipping Solution answered HTTP 503 for the shipment list", 503));
    for (const status of [404, 405, 409, 418, 501]) {
      const { fetch: f, sent: s } = scripted(json(status, { Message: "No" }), LIST);
      const error = await failure(client(f).shipments([gid(1)]));
      expect(error, String(status)).toEqual(new JmShippingApiError(`JM Shipping Solution answered HTTP ${status} for the shipments: No`, status));
      expect(s).toHaveLength(1);
    }
  });

  it("turns a 401 or 403 into a config error naming the settings, and a 400 into one saying what to check, masking the credentials", async () => {
    for (const status of [401, 403]) {
      const { fetch, sent } = scripted(json(status, { Message: `Key ${KEY} with ${PASSWORD} is not allowed` }));
      const error = await failure(client(fetch).tracking([gid(1)]));
      expect(error, String(status)).toEqual(new JmShippingConfigError(`JM Shipping Solution turned down the credentials (HTTP ${status}): Key *** with *** is not allowed; ${SETTINGS}`));
      expect(sent).toHaveLength(1);
    }
    const quiet = scripted(plain(401, "nope"));
    expect(await failure(client(quiet.fetch).claim(gid(1)))).toEqual(new JmShippingConfigError(`JM Shipping Solution turned down the credentials (HTTP 401); ${SETTINGS}`));
    const bad = scripted(json(400, { Error: [{ ErrorCode: "400", ErrorMessage: `Bad header ${BASIC.slice(6)}` }] }));
    const error = await failure(client(bad.fetch).reconciled("2026-11-01", "2026-11-02"));
    expect(error).toEqual(
      new JmShippingApiError(`JM Shipping Solution answered HTTP 400 for the reconciled shipments: Bad header ***; JM gives 400 for a bad request and for credentials it doesn't accept, so check that ${SETTINGS}, and that JM_SHIPPING_CLIENT_ID is the store's`, 400),
    );
    expect((error as JmShippingApiError).status).toBe(400);
    expect(bad.sent).toHaveLength(1);
    const said = scripted(json(400, { ErrorMessage: `  spaced \n  out  ${"z".repeat(300)}` }));
    const long = await failure(client(said.fetch).shipments([gid(1)]));
    expect(long?.message).toContain(`: spaced out ${"z".repeat(200 - "spaced out ".length)};`);
    for (const e of [error, long]) {
      expect(e?.message).not.toContain(KEY);
      expect(e?.message).not.toContain(PASSWORD);
    }
  });

  it("never puts the URL or credentials in an error when JM can't be reached", async () => {
    const fetch = (async () => {
      throw new Error(`connect ECONNRESET ${JM_SHIPPING_UAT_BASE} ${KEY}`);
    }) as unknown as typeof globalThis.fetch;
    const error = await failure(client(fetch).shipmentGids("2026-11-01", "2026-11-02"));
    expect(error).toEqual(new JmShippingApiError("JM Shipping Solution could not be reached for the shipment list", 0));
    expect(`${error?.message}${String((error as { cause?: unknown }).cause ?? "")}`).not.toContain(KEY);
  });

  it("turns down answers that don't read, and a shipment list that carries an error", async () => {
    const ask = async (answer: () => Response, call: (c: ReturnType<typeof client>) => Promise<unknown>) => failure(call(client(scripted(answer).fetch)));
    const list = (c: ReturnType<typeof client>) => c.shipmentGids("2026-11-01", "2026-11-02");
    for (const body of [[], null, "x", 5]) expect(await ask(json(200, body), list), JSON.stringify(body)).toEqual(new JmShippingApiError("JM Shipping Solution answered the shipment list without an object", 200));
    expect(await ask(plain(200, "not json"), list)).toEqual(new JmShippingApiError("JM Shipping Solution answered the shipment list without an object", 200));
    expect(await ask(json(200, { ShipmentGids: "x" }), list)).toEqual(new JmShippingApiError("JM Shipping Solution answered the shipment list without a list of GUIDs", 200));
    expect(await ask(json(200, { Error: [{ ErrorCode: 400, ErrorMessage: "Start date must be before end date" }, {}], ShipmentGids: [] }), list)).toEqual(
      new JmShippingApiError("JM Shipping Solution answered the shipment list with an error: 400 Start date must be before end date; an error without a message", 200),
    );
    expect(await list(client(scripted(json(200, {})).fetch))).toEqual([]);
    expect(await list(client(scripted(json(200, { Error: [], ShipmentGids: null })).fetch))).toEqual([]);
    expect(await list(client(scripted(json(200, { Error: null, ShipmentGids: [1, "x"] })).fetch))).toEqual([1, "x"]);
    for (const [name, call] of [
      ["shipments", (c: ReturnType<typeof client>) => c.shipments([gid(1)])],
      ["tracking", (c: ReturnType<typeof client>) => c.tracking([gid(1)])],
      ["reconciled shipments", (c: ReturnType<typeof client>) => c.reconciled("2026-11-01", "2026-11-02")],
    ] as const) {
      for (const body of [{}, null, "x"]) expect(await ask(json(200, body), call), `${name} ${JSON.stringify(body)}`).toEqual(new JmShippingApiError(`JM Shipping Solution answered the ${name} without a list`, 200));
      expect(await call(client(scripted(json(200, [])).fetch))).toEqual([]);
    }
    const claimOf = (c: ReturnType<typeof client>) => c.claim(gid(1));
    for (const body of [[], null, "x", 5]) expect(await ask(json(200, body), claimOf), JSON.stringify(body)).toEqual(new JmShippingApiError("JM Shipping Solution answered the claim without an object", 200));
    expect(await claimOf(client(scripted(json(404, { Message: "Claim not found" })).fetch))).toBeNull();
    expect(await claimOf(client(scripted(json(200, {})).fetch))).toEqual({});
  });

  it("reads JM's error lists", () => {
    expect(jmShippingErrors(null)).toEqual([]);
    expect(jmShippingErrors({ ErrorCode: "1" })).toEqual([]);
    expect(jmShippingErrors([])).toEqual([]);
    expect(jmShippingErrors([{ ErrorCode: "E1", ErrorMessage: " Bad " }, { ErrorCode: 7 }, { ErrorMessage: "m" }, null, { ErrorCode: true, ErrorMessage: 5 }])).toEqual(["E1 Bad", "7", "m", "an error without a message", "an error without a message"]);
    expect(jmShippingErrors([{ ErrorCode: "c".repeat(30), ErrorMessage: "m".repeat(300) }])).toEqual([`${"c".repeat(20)} ${"m".repeat(200)}`]);
  });
});

/** The facts shipment `n` gives the tracking and claim events, from the fixture. */
const factsOf = (n: number): JmShipmentFacts => jmShipmentEvent(shipment(n), RECEIVED).facts!;
const factsMap = (...ns: number[]) => new Map(ns.map((n) => [gid(n), factsOf(n)]));

describe("JM Shipping Solution shipment events", () => {
  it("keeps what sales and finance use of a shipment, and no names, addresses, postal codes or contact details", () => {
    jmShippingShipment.reset();
    const raw = shipment(1);
    const read = jmShipmentEvent(raw, RECEIVED);
    expect(read.ok).toBe(true);
    expect(read.event).toMatchObject({ type: JM_SHIPMENT_EVENT, occurredAt: "2026-10-01T15:00:00.000Z", receivedAt: RECEIVED });
    expect(read.event.payload).toEqual({
      system: "JM Shipping Solution",
      shipmentId: ref(1),
      jmId: 70001,
      orderRef: "ORD-1",
      status: "label_purchased",
      voided: false,
      carrier: "ups",
      service: "two_day_am",
      trackingNumber: "JMTEST000001",
      trackingStatus: "in_transit",
      jmTrackingStatus: "enroute",
      insuredCents: 250000,
      invoiceCents: 300000,
      underinsuredCents: 50000,
      costCents: 4250,
      freightCents: 3000,
      insuranceCostCents: 1250,
      currency: "USD",
      weightOz: 8.5,
      isReturn: false,
      holdForPickup: false,
      approvalRequired: false,
      reconciled: false,
      destinationState: "CA",
      destinationCountry: "US",
      shipDate: "2026-10-01T15:00:00.000Z",
      carrierDeliveryAt: "2026-10-03T15:00:00.000Z",
      createdAt: "2026-10-01T15:00:00.000Z",
    });
    expect(read.facts).toEqual({ gid: gid(1), carrier: "ups", service: "two_day_am", trackingNumber: "JMTEST000001", destinationState: "CA", destinationCountry: "US", claimable: true });
    const text = JSON.stringify(read.event);
    for (const dropped of ["Test Street", "Suite", "Test City", "Test Company", "Test Customer", "example.test", "555", "90001", "10001", "Gift", "label.pdf", "TEST-ACCOUNT", "zing", "trace"]) expect(text, dropped).not.toContain(dropped);
    assertSynthetic(read.event.payload);
    assertSynthetic(raw);
  });

  it("maps a saved, bought and voided shipment, and dead-letters a status JM doesn't document", () => {
    const status = (fields: Record<string, unknown>, outer: Record<string, unknown> = {}) => jmShipmentEvent(shipment(1, fields, outer), RECEIVED);
    expect(status({}, { ShipmentStatus: 0 }).event.payload).toMatchObject({ status: "pending", voided: false });
    expect(status({}, { ShipmentStatus: 0 }).facts!.claimable).toBe(false);
    const voided = status({ VoidedOn: "2026-10-02T12:00:00Z", VoidId: 5 });
    expect(voided.event.payload).toMatchObject({ status: "cancelled", voided: true, voidedAt: "2026-10-02T12:00:00.000Z" });
    expect(voided.event.occurredAt).toBe("2026-10-02T12:00:00.000Z");
    expect(voided.facts!.claimable).toBe(false);
    const byId = status({ VoidId: 1 });
    expect(byId.event.payload).toMatchObject({ status: "cancelled", voided: true });
    expect(byId.event.payload).not.toHaveProperty("voidedAt");
    expect(status({ VoidId: 0, VoidedOn: null }).event.payload).toMatchObject({ status: "label_purchased", voided: false });
    expect(status({ VoidedOn: "0001-01-01T00:00:00Z" }).event.payload).toMatchObject({ voided: false });
    expect(status({}, { Status: 2 }).ok).toBe(true);
    expect(status({}, { Status: 3 }).ok).toBe(true);
    for (const s of [2, -1, "1", null, undefined]) {
      const read = status({}, { ShipmentStatus: s });
      expect(read.ok, String(s)).toBe(false);
      expect(read.event.payload).toEqual({ system: "JM Shipping Solution", kind: "shipment", problems: ["shipment has no status JM documents"] });
      expect(read.facts).toBeUndefined();
    }
  });

  it("dead-letters a failed shipment, one without a GUID or time, and one that isn't an object, listing each problem", () => {
    const failed = jmShipmentEvent(shipment(1, {}, { Status: 0, Error: [{ ErrorCode: "E9", ErrorMessage: "Address not found" }] }), RECEIVED);
    expect(failed.ok).toBe(false);
    expect(failed.event.occurredAt).toBeUndefined();
    expect(failed.event.payload.problems).toEqual(["JM answered the shipment with a failure: E9 Address not found"]);
    expect(jmShipmentEvent(shipment(1, {}, { Status: 0, Error: [] }), RECEIVED).event.payload.problems).toEqual(["JM answered the shipment with a failure"]);
    const s = shipment(1, { Gid: "nope", TransactionTime: "2026-10-01", ShipDate: null }, { Purchase: { Gid: 7 } });
    const read = jmShipmentEvent(s, RECEIVED);
    expect(read.event.payload.problems).toEqual(["shipment has no GUID that reads", "shipment has no time that reads"]);
    expect(read.event.idempotencyKey).toMatch(/^jm_shipping:unreadable_shipment:[0-9a-f]{12}$/);
    expect(read.event.id).toBe(read.event.idempotencyKey.replace(/:/g, "_"));
    expect(jmShipmentEvent(shipment(1, { Gid: null }), RECEIVED).event.payload).toMatchObject({ shipmentId: ref(1) });
    for (const raw of [null, [], "x"]) expect(jmShipmentEvent(raw, RECEIVED).event.payload.problems, JSON.stringify(raw)).toEqual(["shipment is not an object", "shipment has no GUID that reads", "shipment has no status JM documents", "shipment has no time that reads"]);
    // The time falls back from the purchase to the ship date.
    expect(jmShipmentEvent(shipment(1, { TransactionTime: null, ShipDate: "2026-10-05T00:00:00+02:00" }), RECEIVED).event.occurredAt).toBe("2026-10-04T22:00:00.000Z");
  });

  it("keys a shipment by its GUID and what was kept, so a change is a new event", () => {
    const a = jmShipmentEvent(shipment(1), RECEIVED).event;
    const b = jmShipmentEvent(shipment(1), "2026-12-01T00:00:00.000Z").event;
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toMatch(new RegExp(`^jm_shipping:shipment:${gid(1)}:[0-9a-f]{16}$`));
    expect(a.id).toBe(a.idempotencyKey.replace(/:/g, "_"));
    expect(jmShipmentEvent(shipment(1, { TrackingStatus: 90 }), RECEIVED).event.idempotencyKey).not.toBe(a.idempotencyKey);
    // What isn't kept doesn't change the key.
    expect(jmShipmentEvent(shipment(1, { Reference2: "Other note" }), RECEIVED).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(jmShipmentEvent(shipment(1, { Gid: gid(1).toUpperCase() }), RECEIVED).event.idempotencyKey).toBe(a.idempotencyKey);
  });

  it("reads one carrier and service, and leaves out what doesn't read", () => {
    expect(jmShippingOne(JM_CARRIERS, [7])).toBe("ups");
    expect(jmShippingOne(JM_CARRIERS, [0, 3])).toBe("fedex");
    expect(jmShippingOne(JM_CARRIERS, [9, 9])).toBe("usps");
    expect(jmShippingOne(JM_CARRIERS, [7, 3])).toBeUndefined();
    expect(jmShippingOne(JM_CARRIERS, [])).toBeUndefined();
    expect(jmShippingOne(JM_CARRIERS, [0])).toBeUndefined();
    expect(jmShippingOne(JM_CARRIERS, [11])).toBeUndefined();
    expect(jmShippingOne(JM_CARRIERS, ["7"])).toBeUndefined();
    expect(jmShippingOne(JM_CARRIERS, 7)).toBeUndefined();
    expect([...JM_CARRIERS.values()]).toEqual(["dhl_express", "eastern_connection", "fedex", "lonestar", "newgistics", "ontrac", "ups", "dhl_gm", "usps", "purolator", "other"]);
    expect([...JM_CARRIERS.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]);
    expect([...JM_SERVICES.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(JM_SERVICES.get(7)).toBe("ground_or_first_class");
    expect(JM_SERVICES.get(12)).toBe("international_4");
    const bare = jmShipmentEvent(
      shipment(1, { Carriers: [7, 3], Services: [], TrackingNumber: "x", TrackingStatus: 999, DeclaredValue: -1, InvoiceValue: "3000", WeightOzDecimal: 0, Reference1: "Order 1", ToAddress: { State: "California", CountryCode: "USA" }, CarrierDeliveryDate: "soon", Id: 0 }, { Rates: [], Purchase: {} }),
      RECEIVED,
    );
    expect(bare.ok).toBe(true);
    expect(bare.event.payload).toEqual({
      system: "JM Shipping Solution",
      shipmentId: ref(1),
      status: "label_purchased",
      voided: false,
      isReturn: false,
      holdForPickup: false,
      approvalRequired: false,
      reconciled: false,
      shipDate: "2026-10-01T15:00:00.000Z",
      createdAt: "2026-10-01T15:00:00.000Z",
    });
    expect(bare.facts).toEqual({ gid: gid(1), carrier: undefined, service: undefined, trackingNumber: undefined, destinationState: undefined, destinationCountry: undefined, claimable: true });
    // The tracking number falls back from the purchase to the shipment.
    expect(jmShipmentEvent(shipment(1, { TrackingNumber: "JMTEST999999" }, { Purchase: {} }), RECEIVED).event.payload.trackingNumber).toBe("JMTEST999999");
  });

  it("takes the cost only from a single rate, and the shortfall only when both values read", () => {
    const of = (fields: Record<string, unknown>, outer: Record<string, unknown> = {}) => jmShipmentEvent(shipment(1, fields, outer), RECEIVED).event.payload;
    const two = of({}, { Rates: [{ Price: 1 }, { Price: 2 }] });
    for (const k of ["costCents", "freightCents", "insuranceCostCents"]) expect(two).not.toHaveProperty(k);
    expect(of({}, { Rates: [{ Price: 10 }] })).toMatchObject({ costCents: 1000 });
    expect(of({}, { Rates: [{ Price: 10 }] })).not.toHaveProperty("freightCents");
    expect(of({ DeclaredValue: 3000 })).toMatchObject({ underinsuredCents: 0 });
    expect(of({ DeclaredValue: 3500 })).toMatchObject({ underinsuredCents: 0 });
    expect(of({ DeclaredValue: 2999.99 })).toMatchObject({ underinsuredCents: 1 });
    expect(of({ DeclaredValue: 0 })).toMatchObject({ insuredCents: 0, underinsuredCents: 300000 });
    expect(of({ InvoiceValue: null })).not.toHaveProperty("underinsuredCents");
    expect(of({ DeclaredValue: null })).not.toHaveProperty("underinsuredCents");
    const none = of({ DeclaredValue: null, InvoiceValue: null }, { Rates: [] });
    expect(none).not.toHaveProperty("currency");
    expect(of({ DeclaredValue: null, InvoiceValue: 1 }, { Rates: [] })).toMatchObject({ currency: "USD" });
    expect(of({ DeclaredValue: null, InvoiceValue: null }, { Rates: [{ InsurancePrice: 0 }] })).toMatchObject({ currency: "USD", insuranceCostCents: 0 });
    expect(of({ WeightOzDecimal: 0.01 })).toMatchObject({ weightOz: 0.01 });
    expect(of({ WeightOzDecimal: 1e6 })).toMatchObject({ weightOz: 1e6 });
    expect(of({ WeightOzDecimal: 2.346 })).toMatchObject({ weightOz: 2.35 });
    for (const w of [0, -1, 1e6 + 1, Number.NaN, "8"]) expect(of({ WeightOzDecimal: w }), String(w)).not.toHaveProperty("weightOz");
    expect(of({ IsReturnShipment: true, IsHoldForPickup: true, ApprovalRequired: true, IsReconciled: true })).toMatchObject({ isReturn: true, holdForPickup: true, approvalRequired: true, reconciled: true });
    expect(of({ IsReturnShipment: "true" })).toMatchObject({ isReturn: false });
    expect(of({ ToAddress: { State: " ny ", CountryCode: "ca" } })).toMatchObject({ destinationState: "NY", destinationCountry: "CA" });
    expect(of({ ToAddress: { State: "ON1", CountryCode: "C" } })).not.toHaveProperty("destinationState");
    expect(of({ ToAddress: { State: "NSW" } })).toMatchObject({ destinationState: "NSW" });
    expect(of({ ToAddress: { State: "N" } })).not.toHaveProperty("destinationState");
  });

  it("reads ids, times, money, tracking numbers and references at their edges", () => {
    expect(jmShippingGid(gid(1).toUpperCase())).toBe(gid(1));
    expect(jmShippingGid("x")).toBeUndefined();
    expect(jmShippingId(1)).toBe(1);
    for (const v of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expect(jmShippingId(v), String(v)).toBeUndefined();
    expect(jmShippingTime("2026-10-01T15:00:00Z")).toBe("2026-10-01T15:00:00.000Z");
    expect(jmShippingTime("2026-10-01T15:00Z")).toBe("2026-10-01T15:00:00.000Z");
    expect(jmShippingTime("2026-10-01T15:00:00.1234567+05:30")).toBe("2026-10-01T09:30:00.123Z");
    expect(jmShippingTime("2000-01-01T00:00:00Z")).toBe("2000-01-01T00:00:00.000Z");
    for (const v of ["1999-12-31T23:59:59Z", "0001-01-01T00:00:00Z", "2026-10-01T15:00:00", "2026-10-01", "2026-13-01T00:00:00Z", "", null, 1_700_000_000]) expect(jmShippingTime(v), String(v)).toBeUndefined();
    expect(jmShippingCents(0)).toBe(0);
    expect(jmShippingCents(42.5)).toBe(4250);
    expect(jmShippingCents(0.1 + 0.2)).toBe(30);
    expect(jmShippingCents(1e9)).toBe(1e11);
    for (const v of [-0.01, 1e9 + 1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) expect(jmShippingCents(v), String(v)).toBeUndefined();
    expect(jmShippingSignedCents(-3)).toBe(-300);
    expect(jmShippingSignedCents(-1e9)).toBe(-1e11);
    expect(jmShippingSignedCents(1e9)).toBe(1e11);
    for (const v of [-1e9 - 1, 1e9 + 1, Number.NaN, "1"]) expect(jmShippingSignedCents(v), String(v)).toBeUndefined();
    expect(jmShippingTrackingNumber(" jmtest01 ")).toBe("JMTEST01");
    expect(jmShippingTrackingNumber("A".repeat(40))).toBe("A".repeat(40));
    for (const v of ["JMTEST0", "A".repeat(41), "JM TEST 01", "JM-TEST-01", 12345678]) expect(jmShippingTrackingNumber(v), String(v)).toBeUndefined();
    expect(jmShippingReference(" ORD-1 ")).toBe("ORD-1");
    expect(jmShippingReference("#1001")).toBe("#1001");
    expect(jmShippingReference("a".repeat(50))).toBe("a".repeat(50));
    for (const v of ["a".repeat(51), "Order 1", "-1", "", "<b>1</b>", 1001]) expect(jmShippingReference(v), String(v)).toBeUndefined();
  });
});

describe("JM Shipping Solution tracking events", () => {
  it("keeps the latest activity, with the shipment's carrier, and none of its city or postal code", () => {
    jmShippingTracking.reset();
    const raw = tracking(1);
    const read = jmTrackingEvent(raw, factsMap(1), RECEIVED)!;
    expect(read.ok).toBe(true);
    expect(read.event).toMatchObject({ type: JM_TRACKING_EVENT, occurredAt: "2026-10-02T16:00:00.000Z" });
    expect(read.event.payload).toEqual({
      system: "JM Shipping Solution",
      shipmentId: ref(1),
      carrier: "ups",
      trackingNumber: "JMTEST000001",
      status: "out_for_delivery",
      jmStatus: "out_for_delivery",
      carrierStatus: "OT",
      description: "Out for delivery",
      lastEventAt: "2026-10-02T16:00:00.000Z",
      service: "two_day_am",
      destinationState: "CA",
      destinationCountry: "US",
    });
    expect(JSON.stringify(read.event)).not.toMatch(/Test City|90001|zing/);
    assertSynthetic(read.event.payload);
    // The latest activity wins whatever order they come in, and one without a time is passed over.
    const activities = obj(raw).Activities as Record<string, unknown>[];
    const reordered = jmTrackingEvent({ ...raw, Activities: [activities[1], { ...activities[0], activityDateTime: "later" }, activities[0]] }, factsMap(1), RECEIVED)!;
    expect(reordered.event.payload.status).toBe("out_for_delivery");
    const older = jmTrackingEvent({ ...raw, Activities: [activities[0]] }, factsMap(1), RECEIVED)!;
    expect(older.event.payload).toMatchObject({ status: "in_transit", jmStatus: "enroute", carrierStatus: "DP", lastEventAt: "2026-10-01T16:00:00.000Z" });
    const same = [activities[0], { ...activities[0], tgActivityCode: 90 }];
    expect(jmTrackingEvent({ ...raw, Activities: same }, factsMap(1), RECEIVED)!.event.payload.status).toBe("in_transit");
  });

  it("maps every JM activity code to the status every carrier maps to", () => {
    const expected: [number, string, string][] = [
      [10, "forwarded", "in_transit"],
      [20, "exception", "exception"],
      [21, "stale_tracking", "unknown"],
      [30, "left_notice", "exception"],
      [40, "undeliverable", "exception"],
      [50, "returned", "returned"],
      [60, "unknown", "unknown"],
      [70, "unscanned", "label_created"],
      [80, "enroute", "in_transit"],
      [89, "out_for_delivery", "out_for_delivery"],
      [90, "delivered", "delivered"],
      [100, "unavailable", "unknown"],
      [110, "finalized", "unknown"],
      [111, "manual_close", "unknown"],
      [-1, "not_checked", "unknown"],
    ];
    expect([...JM_TRACKING].map(([code, { name, status }]) => [code, name, status])).toEqual(expected);
    const one = (code: unknown) => jmTrackingEvent(tracking(1, { Activities: [{ tgActivityCode: code, activityDateTime: "2026-10-03T10:00:00Z" }] }), factsMap(1), RECEIVED)!;
    for (const [code, name, status] of expected) expect(one(code).event.payload, String(code)).toMatchObject({ jmStatus: name, status });
    expect(one(90).event.payload.deliveredAt).toBe("2026-10-03");
    for (const code of [89, 50, 110]) expect(one(code).event.payload).not.toHaveProperty("deliveredAt");
    expect(jmShipmentEvent(shipment(1, { TrackingStatus: 90 }), RECEIVED).event.payload).toMatchObject({ trackingStatus: "delivered", jmTrackingStatus: "delivered" });
    for (const code of [0, 11, 112, "90", null]) {
      const read = one(code);
      expect(read.ok, String(code)).toBe(false);
      expect(read.event.payload.problems).toEqual(["tracking activity has no code JM documents"]);
    }
  });

  it("gives nothing for a shipment without tracking yet, and dead-letters tracking that doesn't read", () => {
    expect(jmTrackingEvent(tracking(1, { Activities: [] }), factsMap(1), RECEIVED)).toBeNull();
    expect(jmTrackingEvent(tracking(1, { Activities: null, Status: 0, Error: "Not yet scanned" }), factsMap(1), RECEIVED)).toBeNull();
    const untimed = jmTrackingEvent(tracking(1, { Activities: [{ tgActivityCode: 80, activityDateTime: "2026-10-01" }] }), factsMap(1), RECEIVED)!;
    expect(untimed.ok).toBe(false);
    expect(untimed.event.payload.problems).toEqual(["tracking has no activity with a time that reads"]);
    expect(jmTrackingEvent(tracking(1, { Gid: "x" }), factsMap(1), RECEIVED)!.event.payload.problems).toEqual(["tracking has no shipment GUID that reads"]);
    for (const raw of [null, "x", []]) expect(jmTrackingEvent(raw, factsMap(1), RECEIVED)!.event.payload.problems, JSON.stringify(raw)).toEqual(["tracking is not an object", "tracking has no shipment GUID that reads"]);
  });

  it("cuts the text, reads the carrier's code only when it is one, and falls back to the shipment's tracking number", () => {
    const at = "2026-10-03T10:00:00Z";
    const of = (activity: Record<string, unknown>, fields: Record<string, unknown> = {}, facts = factsMap(1)) => jmTrackingEvent(tracking(1, { Activities: [{ tgActivityCode: 80, activityDateTime: at, ...activity }], ...fields }), facts, RECEIVED)!.event.payload;
    expect(of({ activityDescription: `  Left \n\t the   facility ${"x".repeat(300)}` }).description).toBe(`Left the facility ${"x".repeat(200 - "Left the facility ".length)}`);
    expect(of({ activityDescription: "   " })).not.toHaveProperty("description");
    expect(of({ carrierActivityCode: " A".padEnd(21, "B") }).carrierStatus).toBe("A".padEnd(20, "B"));
    expect(of({ carrierActivityCode: "A".repeat(21) })).not.toHaveProperty("carrierStatus");
    expect(of({ carrierActivityCode: "A B" })).not.toHaveProperty("carrierStatus");
    expect(of({ carrierActivityCode: 5 })).not.toHaveProperty("carrierStatus");
    expect(of({}, { TrackingNumber: null }).trackingNumber).toBe("JMTEST000001");
    expect(of({}, { TrackingNumber: "jmtest777777" }).trackingNumber).toBe("JMTEST777777");
    const alone = of({}, { TrackingNumber: null }, new Map());
    expect(alone).toEqual({ system: "JM Shipping Solution", shipmentId: ref(1), status: "in_transit", jmStatus: "enroute", lastEventAt: "2026-10-03T10:00:00.000Z" });
    const keyOf = (fields: Record<string, unknown>) => jmTrackingEvent(tracking(1, fields), factsMap(1), RECEIVED)!.event.idempotencyKey;
    expect(keyOf({})).toMatch(new RegExp(`^jm_shipping:tracking:${gid(1)}:[0-9a-f]{16}$`));
    expect(keyOf({})).toBe(jmTrackingEvent(tracking(1), factsMap(1), "2027-01-01T00:00:00.000Z")!.event.idempotencyKey);
    expect(keyOf({ ZingId: "other" })).toBe(keyOf({}));
    expect(keyOf({ Activities: [{ tgActivityCode: 90, activityDateTime: at }] })).not.toBe(keyOf({}));
  });
});

describe("JM Shipping Solution claim events", () => {
  it("keeps a claim's status and amounts, and none of its contents, addresses, report number or notes", () => {
    jmShippingClaim.reset();
    const raw = { Claim: claim(2), Error: null };
    const read = jmClaimEvent(raw, factsOf(2), RECEIVED)!;
    expect(read.ok).toBe(true);
    expect(read.event).toMatchObject({ type: JM_CLAIM_EVENT, occurredAt: "2026-10-06T21:00:00.000Z" });
    expect(read.event.payload).toEqual({
      system: "JM Shipping Solution",
      claimId: "jm_shipping:claim:90002",
      shipmentId: ref(2),
      carrier: "ups",
      trackingNumber: "JMTEST000002",
      status: "submitted",
      lossType: "complete",
      reason: "contents_stolen_or_missing",
      cargo: "gems_and_jewelery",
      claimCents: 250000,
      insuredCents: 250000,
      replacementCents: 280000,
      invoiceCents: 300000,
      carrierDeclaredCents: 10000,
      carrierLiabilityCents: 0,
      currency: "USD",
      packages: 1,
      carrierClaimFiled: false,
      postagePurchased: true,
      filedAt: "2026-10-06T21:00:00.000Z",
      dueAt: "2026-11-30T21:00:00.000Z",
      shipDate: "2026-10-01T21:00:00.000Z",
    });
    const text = JSON.stringify(read.event);
    for (const dropped of ["ring", "REPORT", "Test Street", "Test Customer", "example.test", "notes", "damage", "comment", "steps", "SUBMITTED"]) expect(text, dropped).not.toContain(dropped);
    assertSynthetic(read.event.payload);
    assertSynthetic(raw);
  });

  it("gives nothing for a shipment without a claim", () => {
    for (const raw of [{ Claim: { Id: 0, Status: 2 }, Error: [] }, { Claim: null, Error: [{ ErrorMessage: "No claim" }] }, { Error: [] }, {}, { Claim: { Status: 4 } }, { Claim: { Id: null } }]) {
      expect(jmClaimEvent(raw, factsOf(1), RECEIVED), JSON.stringify(raw)).toBeNull();
    }
  });

  it("maps each documented claim status, and dead-letters filter values, other statuses and ids that don't read", () => {
    const of = (fields: Record<string, unknown>) => jmClaimEvent({ Claim: claim(2, fields) }, factsOf(2), RECEIVED)!;
    expect([...JM_CLAIM_STATUSES.keys()]).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    for (const [n, name] of JM_CLAIM_STATUSES) expect(of({ Status: n }).event.payload.status, String(n)).toBe(name);
    expect(JM_CLAIM_STATUSES.get(12)).toBe("paid");
    expect(JM_CLAIM_STATUSES.get(14)).toBe("denied");
    for (const s of [0, 1, 17, "4", null]) {
      const read = of({ Status: s });
      expect(read.ok, String(s)).toBe(false);
      expect(read.event.payload).toEqual({ system: "JM Shipping Solution", kind: "claim", problems: ["claim has no status JM documents"] });
      expect(read.event.idempotencyKey).toMatch(/^jm_shipping:unreadable_claim:[0-9a-f]{12}$/);
    }
    for (const id of [-1, 1.5, "90002"]) expect(of({ Id: id }).event.payload.problems, String(id)).toEqual(["claim has no id that reads"]);
    for (const raw of [null, "x", []]) expect(jmClaimEvent(raw, factsOf(2), RECEIVED)!.event.payload.problems, JSON.stringify(raw)).toEqual(["claim answer is not an object", "claim has no status JM documents"]);
  });

  it("takes the insured value as the claim when none is given, and leaves out what doesn't read", () => {
    const of = (fields: Record<string, unknown>) => jmClaimEvent({ Claim: claim(2, fields) }, factsOf(2), RECEIVED)!.event;
    for (const v of [0, null]) {
      const p = of({ ClaimValue: v }).payload;
      expect(p, String(v)).not.toHaveProperty("claimCents");
      expect(p.claimIsInsuredValue).toBe(true);
    }
    expect(of({ ClaimValue: 0.01 }).payload).toMatchObject({ claimCents: 1 });
    expect(of({}).payload).not.toHaveProperty("claimIsInsuredValue");
    expect(of({ LossType: 2, ReasonForClaim: 3, eCargo: 1 }).payload).toMatchObject({ lossType: "partial", reason: "contents_damaged", cargo: "watches" });
    for (const k of ["lossType", "reason", "cargo"]) expect(of({ LossType: 0, ReasonForClaim: 0, eCargo: 0 }).payload, k).not.toHaveProperty(k);
    expect(of({ ReasonForClaim: 1 }).payload.reason).toBe("not_received");
    expect(of({ ReasonForClaim: 2 }).payload.reason).toBe("failed_to_deliver");
    expect(of({ ReasonForClaim: 5 }).payload.reason).toBe("other");
    expect(of({ ReasonForClaim: 6 }).payload).not.toHaveProperty("reason");
    expect(of({ CarrierClaimNumber: "C-1" }).payload.carrierClaimFiled).toBe(true);
    expect(of({ CarrierClaimNumber: "  " }).payload.carrierClaimFiled).toBe(false);
    expect(of({ CarrierClaimNumber: null }).payload.carrierClaimFiled).toBe(false);
    expect(of({ PostagePurchased: false }).payload.postagePurchased).toBe(false);
    for (const v of [0, -1, 1.5, "1"]) expect(of({ PackageCount: v }).payload, String(v)).not.toHaveProperty("packages");
    expect(of({ PackageCount: 3 }).payload.packages).toBe(3);
    expect(of({ TrackingNumber: null }).payload.trackingNumber).toBe("JMTEST000002");
    const empty = of({ ClaimValue: null, InsuredValue: null, ReplacementValue: null, InvoiceValue: null, CarrierDeclaredValue: null, CarrierLiability: null });
    expect(empty.payload).not.toHaveProperty("currency");
    expect(of({ ClaimValue: null, InsuredValue: null, ReplacementValue: null, InvoiceValue: null, CarrierDeclaredValue: null, CarrierLiability: 0 }).payload.currency).toBe("USD");
    // A claim not filed yet is seen when it is read.
    const unfiled = of({ ClaimFiledOn: null, Status: 3 });
    expect(unfiled.occurredAt).toBe(RECEIVED);
    expect(unfiled.payload).not.toHaveProperty("filedAt");
    expect(unfiled.idempotencyKey).toBe(jmClaimEvent({ Claim: claim(2, { ClaimFiledOn: null, Status: 3 }) }, factsOf(2), "2027-01-01T00:00:00.000Z")!.event.idempotencyKey);
    expect(of({}).idempotencyKey).toMatch(/^jm_shipping:claim:90002:[0-9a-f]{16}$/);
    expect(of({ Status: 12 }).idempotencyKey).not.toBe(of({}).idempotencyKey);
    expect(of({ Comment: "Other" }).idempotencyKey).toBe(of({}).idempotencyKey);
    expect(JM_CARGO.get(7)).toBe("gems_and_jewelery");
    expect(JM_CARGO.get(100)).toBe("other");
    expect(JM_CARGO.size).toBe(38);
  });
});

describe("JM Shipping Solution reconciliation events", () => {
  it("keeps the freight quoted and billed and the adjustment, and no companies, contacts or comments", () => {
    jmShippingReconciled.reset();
    const raw = reconciled(1);
    const read = jmReconciledEvent(raw, RECEIVED);
    expect(read.ok).toBe(true);
    expect(read.event).toMatchObject({ type: JM_RECONCILED_EVENT, occurredAt: "2026-10-08T15:00:00.000Z" });
    expect(read.event.payload).toEqual({
      system: "JM Shipping Solution",
      shipmentId: ref(1),
      jmId: 70001,
      trackingNumber: "JMTEST000001",
      carrier: "ups",
      service: "two_day_am",
      cargo: "gems_and_jewelery",
      originalFreightCents: 3000,
      freightCents: 3300,
      adjustmentCents: 300,
      currency: "USD",
      invoiceRef: "INV-TEST-1",
      purchasedAt: "2026-10-01T15:00:00.000Z",
      reconciledAt: "2026-10-08T15:00:00.000Z",
    });
    for (const dropped of ["Test Jeweler", "Test Company", "Test Customer", "Order for", "comment", "review"]) expect(JSON.stringify(read.event), dropped).not.toContain(dropped);
    assertSynthetic(read.event.payload);
    assertSynthetic(raw);
  });

  it("keeps a credit, leaves out what doesn't read, and keys each reconciliation by its time", () => {
    expect(jmReconciledEvent(reconciled(1, { AdjustmentAmount: -4.25 }), RECEIVED).event.payload.adjustmentCents).toBe(-425);
    const bare = jmReconciledEvent(reconciled(1, { ShipmentId: 0, TrackingNumber: "", Carrier: 0, Service: 99, Cargo: 0, OriginalFreightPrice: -1, AdjustmentAmount: "3", InvoiceReference: "INV 1", PurchasedOn: null }), RECEIVED);
    expect(bare.event.payload).toEqual({ system: "JM Shipping Solution", shipmentId: ref(1), freightCents: 3300, currency: "USD", reconciledAt: "2026-10-08T15:00:00.000Z" });
    const a = jmReconciledEvent(reconciled(1), RECEIVED).event.idempotencyKey;
    expect(a).toMatch(new RegExp(`^jm_shipping:reconciliation:${gid(1)}:2026-10-08T15:00:00.000Z:[0-9a-f]{16}$`));
    expect(jmReconciledEvent(reconciled(1, { ReconciledOn: "2026-10-09T15:00:00Z" }), RECEIVED).event.idempotencyKey).not.toBe(a);
    expect(jmReconciledEvent(reconciled(1, { Comment: "Other" }), RECEIVED).event.idempotencyKey).toBe(a);
    expect(jmReconciledEvent(reconciled(1, { FreightPrice: 0 }), RECEIVED).ok).toBe(true);
  });

  it("dead-letters a reconciliation without a GUID, time or freight price, listing each", () => {
    const read = jmReconciledEvent(reconciled(1, { ShipmentGid: "x", ReconciledOn: "2026-10-08", FreightPrice: -1 }), RECEIVED);
    expect(read.ok).toBe(false);
    expect(read.event.occurredAt).toBeUndefined();
    expect(read.event.payload.problems).toEqual(["reconciled shipment has no GUID that reads", "reconciled shipment has no reconciliation time that reads", "reconciled shipment has no freight price that reads"]);
    expect(read.event.idempotencyKey).toMatch(/^jm_shipping:unreadable_reconciliation:[0-9a-f]{12}$/);
    expect(jmReconciledEvent(null, RECEIVED).event.payload.problems).toEqual([
      "reconciled shipment is not an object",
      "reconciled shipment has no GUID that reads",
      "reconciled shipment has no reconciliation time that reads",
      "reconciled shipment has no freight price that reads",
    ]);
    const listed = jmShippingUnlisted(5, RECEIVED);
    expect(listed.ok).toBe(false);
    expect(listed.event).toMatchObject({ type: JM_SHIPMENT_EVENT, occurredAt: undefined, payload: { system: "JM Shipping Solution", kind: "shipment", problems: ["listed shipment GUID doesn't read"] } });
    expect(listed.event.idempotencyKey).not.toBe(jmShippingUnlisted(6, RECEIVED).event.idempotencyKey);
  });
});

describe("JM Shipping Solution checkpoint", () => {
  it("turns down a checkpoint that isn't its own", async () => {
    expect(parseJmShippingCursor(null)).toBeNull();
    const good: JmShippingCursor[] = [
      { done: true, next: null, end: null },
      { done: false, next: "2026-11-01", end: "2026-11-13" },
      { done: false, next: "2026-11-12", end: "2026-11-13" },
    ];
    for (const c of good) expect(parseJmShippingCursor(JSON.stringify(c))).toEqual(c);
    const bad: unknown[] = [
      "",
      "{",
      "null",
      "[]",
      "5",
      {},
      { done: true },
      { done: true, next: null, end: null, extra: 1 },
      { done: "true", next: null, end: null },
      { done: true, next: "2026-11-01", end: null },
      { done: true, next: null, end: "2026-11-13" },
      { done: false, next: null, end: null },
      { done: false, next: "2026-11-13", end: "2026-11-13" },
      { done: false, next: "2026-11-14", end: "2026-11-13" },
      { done: false, next: "2026-02-30", end: "2026-11-13" },
      { done: false, next: "2026-11-01", end: "2026-11-13T00:00:00Z" },
      { done: false, next: "2026-11-01", end: null },
      { done: 0, next: "2026-11-01", end: "2026-11-13" },
      { synced: [], pass: null },
    ];
    const c = connector(jmShippingDocMock(store()));
    for (const raw of bad) {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      expect(() => parseJmShippingCursor(text), text).toThrow("JM Shipping Solution checkpoint is not in the expected shape");
      expect(await failure(drain(c.incrementalSync({ organizationId: TEST_ORG, cursor: text }))), text).toEqual(new Error("JM Shipping Solution checkpoint is not in the expected shape"));
      expect(await failure(drain(c.historicalImport({ organizationId: TEST_ORG, cursor: text }))), text).toEqual(new Error("JM Shipping Solution checkpoint is not in the expected shape"));
    }
  });
});

const week = (from: string, to: string) => [`${API}/shipment/list/4321/${from}/${to}`, `${API}/shipment/reconciliation/4321/${from}/${to}`];
/** The weeks an incremental sync on NOW walks. */
const WEEKS = [
  ["2026-09-13", "2026-09-20"],
  ["2026-09-20", "2026-09-27"],
  ["2026-09-27", "2026-10-04"],
  ["2026-10-04", "2026-10-11"],
  ["2026-10-11", "2026-10-18"],
  ["2026-10-18", "2026-10-25"],
  ["2026-10-25", "2026-11-01"],
  ["2026-11-01", "2026-11-08"],
  ["2026-11-08", "2026-11-13"],
] as const;
const gids = (...ns: number[]) => ns.map(gid).join(",");

describe("JM Shipping Solution connector", () => {
  const sync = (c: ReturnType<typeof connector>, cursor: JmShippingCursor | string | null = null) => drain(c.incrementalSync({ organizationId: TEST_ORG, cursor: cursor === null || typeof cursor === "string" ? cursor : JSON.stringify(cursor) }));

  it("passes the shared sync checks", async () => {
    // A shipment in the first week of each pass, so the resume check has a first batch to continue after.
    const withFirst = (at: string) => {
      const data = store();
      return { ...data, shipments: [shipment(50, { TransactionTime: at }), ...data.shipments!], tracking: [...data.tracking!, tracking(50)] };
    };
    const result = await checkConnectorSync({ mode: "incremental", makeConnector: () => connector(jmShippingDocMock(withFirst("2026-09-15T10:00:00Z"))), expected: { ingested: 31 } });
    expect(result.full).toMatchObject({ batches: 9, deadLettered: 0 });
    expect(result.resume!.ingested).toBe(29);
    expect(parseJmShippingCursor(result.full.cursor)).toEqual({ done: true, next: null, end: null });
    const historical = await checkConnectorSync({ mode: "historical", makeConnector: () => connector(jmShippingDocMock(withFirst("2021-11-15T10:00:00Z"))), expected: { ingested: 31 } });
    expect(historical.full.batches).toBe(261);
    expect(historical.resume!.ingested).toBe(29);
  });

  it("walks the last 60 days a week at a time, reading details and tracking together and claims one by one", async () => {
    const mock = jmShippingDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 29, deadLettered: 0, duplicates: 0, batches: 9 });
    expect(JM_SHIPPING_REVISIT_DAYS).toBe(60);
    expect(JM_SHIPPING_WINDOW_DAYS).toBe(7);
    const third = [
      `${API}/shipment/list/4321/2026-09-27/2026-10-04`,
      `${API}/shipment/${gids(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)}`,
      `${API}/shipment/track/latest/${gids(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)}`,
      // Shipment 3 is voided and 4 only saved, so neither can have a claim.
      ...[1, 2, 5, 6, 7, 8, 9, 10].map((n) => `${API}/claim/${gid(n)}`),
      `${API}/shipment/reconciliation/4321/2026-09-27/2026-10-04`,
    ];
    const fourth = [`${API}/shipment/list/4321/2026-10-04/2026-10-11`, `${API}/shipment/${gids(11, 12)}`, `${API}/shipment/track/latest/${gids(11, 12)}`, `${API}/claim/${gid(11)}`, `${API}/claim/${gid(12)}`, `${API}/shipment/reconciliation/4321/2026-10-04/2026-10-11`];
    expect(mock.reads).toEqual([...week(...WEEKS[0]), ...week(...WEEKS[1]), ...third, ...fourth, ...WEEKS.slice(4).flatMap(([a, b]) => week(a, b))]);
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === JM_SHIPMENT_EVENT)).toHaveLength(12);
    expect(types.filter((t) => t === JM_TRACKING_EVENT)).toHaveLength(12);
    expect(memory.events.filter((e) => e.type === JM_CLAIM_EVENT).map((e) => e.payload.claimId)).toEqual(["jm_shipping:claim:90002", "jm_shipping:claim:90005"]);
    expect(memory.events.filter((e) => e.type === JM_RECONCILED_EVENT).map((e) => e.payload.shipmentId)).toEqual([ref(1), ref(2), ref(3)]);
    expect(memory.events.find((e) => e.type === JM_SHIPMENT_EVENT && e.payload.shipmentId === ref(3))!.payload.status).toBe("cancelled");
    expect(memory.events.find((e) => e.type === JM_SHIPMENT_EVENT && e.payload.shipmentId === ref(4))!.payload.status).toBe("pending");
    for (const e of memory.events) assertSynthetic(e.payload);
    const all = JSON.stringify(memory.events);
    for (const dropped of ["Test Street", "Test Customer", "Test Company", "example.test", "90001", "Test City", "ring"]) expect(all, dropped).not.toContain(dropped);
    // Read again, nothing changed: every event is a duplicate.
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(again).toMatchObject({ ingested: 0, duplicates: 29, batches: 9 });
  });

  it("gives each week a checkpoint it can resume from, and keeps the day the pass ends on", async () => {
    const mock = jmShippingDocMock(store());
    const batches = await sync(connector(mock));
    expect(batches.map((b) => b.events.length)).toEqual([0, 0, 22, 7, 0, 0, 0, 0, 0]);
    expect(batches.map((b) => parseJmShippingCursor(b.cursor))).toEqual([...WEEKS.slice(0, -1).map(([, to]) => ({ done: false, next: to, end: "2026-11-13" })), { done: true, next: null, end: null }]);
    const before = mock.reads.length;
    // A resumed pass keeps the day it ends on, though it goes on later.
    const rest = await sync(connector(mock, { now: () => new Date("2026-11-20T01:00:00.000Z") }), batches[2]!.cursor);
    expect(rest).toHaveLength(6);
    expect(mock.reads.slice(before)[0]).toBe(`${API}/shipment/list/4321/2026-10-04/2026-10-11`);
    expect(mock.reads.at(-1)).toBe(`${API}/shipment/reconciliation/4321/2026-11-08/2026-11-13`);
    expect(eventsOf(rest).filter((e) => e.type === JM_SHIPMENT_EVENT).map((e) => e.payload.shipmentId)).toEqual([ref(11), ref(12)]);
    // A finished pass starts a fresh one from 60 days back.
    const fresh = await sync(connector(mock), { done: true, next: null, end: null });
    expect(fresh).toHaveLength(9);
    // A last, short week ends on the pass's end.
    const short = await sync(connector(mock), { done: false, next: "2026-11-10", end: "2026-11-13" });
    expect(short.map((b) => b.cursor)).toEqual([JSON.stringify({ done: true, next: null, end: null })]);
    expect(mock.reads.at(-2)).toBe(`${API}/shipment/list/4321/2026-11-10/2026-11-13`);
    const exact = await sync(connector(mock), { done: false, next: "2026-11-06", end: "2026-11-13" });
    expect(exact).toHaveLength(1);
    expect(mock.reads.at(-2)).toBe(`${API}/shipment/list/4321/2026-11-06/2026-11-13`);
    const longer = await sync(connector(mock), { done: false, next: "2026-11-05", end: "2026-11-13" });
    expect(longer.map((b) => parseJmShippingCursor(b.cursor))).toEqual([
      { done: false, next: "2026-11-12", end: "2026-11-13" },
      { done: true, next: null, end: null },
    ]);
  });

  it("imports five years once, oldest first, and then reads nothing", async () => {
    const mock = jmShippingDocMock(store());
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(JM_SHIPPING_HISTORY_YEARS).toBe(5);
    expect(batches).toHaveLength(261);
    expect(mock.reads[0]).toBe(`${API}/shipment/list/4321/2021-11-12/2021-11-19`);
    expect(mock.reads.at(-1)).toBe(`${API}/shipment/reconciliation/4321/2026-11-06/2026-11-13`);
    expect(eventsOf(batches)).toHaveLength(29);
    expect(parseJmShippingCursor(batches.at(-1)!.cursor)).toEqual({ done: true, next: null, end: null });
    const reads = mock.reads.length;
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: batches.at(-1)!.cursor }))).toEqual([]);
    expect(mock.reads).toHaveLength(reads);
    const leap = await drain(connector(jmShippingDocMock(store()), { now: () => new Date("2028-02-29T12:00:00Z") }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, next: "2028-02-27", end: "2028-03-01" }) }));
    expect(leap).toHaveLength(1);
    const fromLeap = jmShippingDocMock(store());
    const first = connector(fromLeap, { now: () => new Date("2028-02-29T12:00:00Z") }).historicalImport({ organizationId: TEST_ORG, cursor: null });
    await first[Symbol.asyncIterator]().next();
    expect(fromLeap.reads[0]).toBe(`${API}/shipment/list/4321/2023-03-01/2023-03-08`);
  });

  it("asks for at most 20 shipments at a time, once each, and dead-letters a listed GUID that doesn't read", async () => {
    const many = Array.from({ length: 23 }, (_, i) => shipment(100 + i, { TransactionTime: "2026-10-05T10:00:00Z" }));
    const listed = jmShippingDocMock(store({ shipments: many, tracking: [], claims: [], reconciled: [] }));
    // The list gives one GUID again in capitals, one again as it was, and one that isn't a GUID.
    const fetch = (async (input: string, init?: RequestInit) => {
      const answer = await listed.fetch(input, init);
      if (!input.includes("/list/")) return answer;
      const b = (await answer.json()) as { ShipmentGids: unknown[] };
      if (b.ShipmentGids.length) b.ShipmentGids.push(gid(100).toUpperCase(), gid(101), "not-a-guid");
      return new Response(JSON.stringify(b), { status: answer.status });
    }) as unknown as typeof globalThis.fetch;
    const batches = await sync(connector(listed, { fetch }));
    const ids = Array.from({ length: 23 }, (_, i) => 100 + i);
    const asked = listed.reads.filter((p) => p.startsWith(`${API}/shipment/`) && !p.includes("/list/") && !p.includes("/reconciliation/"));
    expect(asked).toEqual([`${API}/shipment/${gids(...ids.slice(0, 20))}`, `${API}/shipment/track/latest/${gids(...ids.slice(0, 20))}`, `${API}/shipment/${gids(...ids.slice(20))}`, `${API}/shipment/track/latest/${gids(...ids.slice(20))}`]);
    const events = eventsOf(batches);
    expect(events.filter((e) => e.type === JM_SHIPMENT_EVENT && e.occurredAt !== undefined)).toHaveLength(23);
    expect(events.filter((e) => e.occurredAt === undefined).map((e) => e.payload.problems)).toEqual([["listed shipment GUID doesn't read"]]);
    expect(listed.reads.filter((p) => p.includes("/claim/"))).toHaveLength(23);
  });

  it("dead-letters a shipment that doesn't read, and reads no claim for it", async () => {
    const data = store({ shipments: [shipment(1, {}, { Status: 0, Error: [{ ErrorMessage: "Failed" }] }), shipment(2)], tracking: [tracking(1), tracking(2, { Activities: [] })], claims: [claim(1), claim(2)], reconciled: [reconciled(9, { FreightPrice: null, ReconciledOn: "2026-10-05T00:00:00Z" })] });
    const mock = jmShippingDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Shipment 2 and its claim, shipment 1's tracking (its carrier unknown); shipment 1 and the reconciliation dead-lettered.
    expect(report).toMatchObject({ ingested: 3, deadLettered: 2 });
    expect(mock.reads.filter((r) => r.includes("/claim/"))).toEqual([`${API}/claim/${gid(2)}`]);
    const tracked = memory.events.find((e) => e.type === JM_TRACKING_EVENT)!;
    expect(tracked.payload.shipmentId).toBe(ref(1));
    expect(tracked.payload).not.toHaveProperty("carrier");
  });

  it("reads no claim event for a shipment JM has no claim on, or doesn't know", async () => {
    const mock = jmShippingDocMock(store({ claims: [] }));
    const batches = await sync(connector(mock));
    expect(eventsOf(batches).filter((e) => e.type === JM_CLAIM_EVENT)).toEqual([]);
    expect(mock.reads.filter((r) => r.includes("/claim/"))).toHaveLength(10);
    const unknown = scripted(json(200, { ShipmentGids: [gid(1)] }), json(200, [shipment(1)]), json(200, []), json(404, { Message: "Claim not found" }), json(200, []));
    const one = await sync(connector(mock, { fetch: unknown.fetch }), { done: false, next: "2026-11-10", end: "2026-11-13" });
    expect(eventsOf(one).map((e) => e.type)).toEqual([JM_SHIPMENT_EVENT]);
    expect(unknown.sent.map((s) => new URL(s.url).pathname)).toEqual([`${API}/shipment/list/4321/2026-11-10/2026-11-13`, `${API}/shipment/${gid(1)}`, `${API}/shipment/track/latest/${gid(1)}`, `${API}/claim/${gid(1)}`, `${API}/shipment/reconciliation/4321/2026-11-10/2026-11-13`]);
  });

  it("stops with a message naming the settings when JM turns the credentials down, never showing them, and waits out a rate limit", async () => {
    const wrong = jmShippingDocMock(store({ password: "other-password" }));
    const { memory, pipeline } = testPipeline();
    const error = await failure(runSync({ connector: connector(wrong), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep }));
    expect(error).toBeInstanceOf(JmShippingApiError);
    expect(error?.message).toBe(`JM Shipping Solution answered HTTP 400 for the shipment list: Invalid credentials; JM gives 400 for a bad request and for credentials it doesn't accept, so check that ${SETTINGS}, and that JM_SHIPPING_CLIENT_ID is the store's`);
    expect(`${error?.message}${error?.stack}`).not.toContain(PASSWORD);
    const other = jmShippingDocMock(store({ clientId: 99 }));
    expect((await failure(drain(connector(other).incrementalSync({ organizationId: TEST_ORG, cursor: null }))))?.message).toMatch(/^JM Shipping Solution answered HTTP 400 for the shipment list: Client not accessible;/);
    const turned = scripted(json(401, { Message: "Unauthorized" }));
    const config = await failure(drain(connector(wrong, { fetch: turned.fetch }).incrementalSync({ organizationId: TEST_ORG, cursor: null })));
    expect(config).toEqual(new JmShippingConfigError(`JM Shipping Solution turned down the credentials (HTTP 401): Unauthorized; ${SETTINGS}`));
    const limited = jmShippingDocMock(store({ rateLimits: 2 }));
    const slept: number[] = [];
    const b = testPipeline();
    const report = await runSync({ connector: connector(limited, { sleep: async (ms) => void slept.push(ms) }), mode: "incremental", pipeline: b.pipeline, memory: b.memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(29);
    expect(slept).toEqual([1000, 2000]);
  });

  it("declares buying labels, cancelling, claims and disputes behind the write gate, and turns each down", async () => {
    const c = connector(jmShippingDocMock(store()));
    expect(c.source).toBe("jm_shipping_solution");
    expect(c.writes).toBe(JM_SHIPPING_WRITES);
    expect(JM_SHIPPING_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["purchase_shipment", "append", "each", 5],
      ["cancel_shipment", "update", "each", 5],
      ["submit_claim", "append", "each", 5],
      ["dispute_charge", "append", "each", 5],
    ]);
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = 0;
    for (const action of JM_SHIPPING_WRITES) {
      expect(action.integration).toBe("jm_shipping_solution");
      await expect(gate.run(action, `jm-${action.name}`, async () => void performed++)).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(0);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });
});

describe("JM Shipping Solution doc mock", () => {
  const headers = (key = KEY, password = PASSWORD) => ({ API_KEY: key, authorization: `Basic ${Buffer.from(`${key}:${password}`).toString("base64")}` });
  const get = (mock: JmShippingMock, path: string, h: Record<string, string> = headers()) => mock.fetch(`${JM_SHIPPING_UAT_BASE}${API}${path}`, { headers: h });
  const body = async (r: Promise<Response>) => (await r).json() as Promise<unknown>;

  it("names the reference pages it was built from", () => {
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "jm_shipping_solution")!;
    const ref = "https://docs.jewelersmutual.com/jm-shipping-solution/api-reference/jm-shipping-solution";
    expect(module.watchPages).toEqual([
      "https://docs.jewelersmutual.com/jm-shipping-solution/overview",
      `${ref}/shipments/getbyclientidstartdateenddate.md`,
      `${ref}/shipments/getbyids.md`,
      `${ref}/tracking/trackbyidsfullhistory.md`,
      `${ref}/claims/getbyid.md`,
      `${ref}/reconciliation/reconciledshipmentsbyclientidstartdateenddate.md`,
    ]);
    expect(Object.values(JM_SHIPPING_DOC_PAGES)).toEqual(module.watchPages);
    const [mock] = module.docMocks();
    expect(mock!.baseUrl).toBe("https://uat2.transguardian.com");
    expect(mock!.source).toMatchObject({ url: JM_SHIPPING_DOC_PAGES.overview, version: "v1", retrievedOn: "2026-11-12" });
    expect(mock!.routes.map((r) => [r.method, r.path, r.documentedAt])).toEqual([
      ["GET", "/api/v1/shipment/list/{clientId}/{startDate}/{endDate}", JM_SHIPPING_DOC_PAGES.shipmentList],
      ["GET", "/api/v1/shipment/{ids}", JM_SHIPPING_DOC_PAGES.shipments],
      ["GET", "/api/v1/shipment/track/{fullHistory}/{ids}", JM_SHIPPING_DOC_PAGES.tracking],
      ["GET", "/api/v1/claim/{id}", JM_SHIPPING_DOC_PAGES.claim],
      ["GET", "/api/v1/shipment/reconciliation/{clientId}/{startDate}/{endDate}", JM_SHIPPING_DOC_PAGES.reconciliation],
    ]);
    expect(mock!.assumptions.length).toBeGreaterThan(5);
    jmShippingShipment.reset();
    assertSynthetic(jmShippingShipment.many(3));
    assertSynthetic([jmShippingTracking.one(), jmShippingClaim.one(), jmShippingReconciled.one()]);
  });

  it("wants the key and basic credentials, answering 400 as JM does, and no query string", async () => {
    const mock = jmShippingDocMock(store());
    const path = "/shipment/list/4321/2026-10-01/2026-10-02";
    for (const h of [{}, headers("00000000-0000-4000-8000-000000000000"), headers(KEY, "wrong"), { API_KEY: KEY }, { authorization: headers().authorization }]) {
      const r = await get(mock, path, h);
      expect(r.status, JSON.stringify(Object.keys(h))).toBe(400);
      expect(await r.json()).toEqual({ Message: "Invalid credentials" });
    }
    expect((await get(jmShippingDocMock({ apiKey: "", password: "" }), path, headers("", ""))).status).toBe(400);
    expect(await body(get(mock, `${path}?page=2`))).toEqual({ Message: "This endpoint takes no query parameters" });
    expect(mock.reads).toEqual([]);
    const limited = jmShippingDocMock(store({ rateLimits: 1 }));
    expect((await get(limited, path)).status).toBe(429);
    expect((await get(limited, path)).status).toBe(200);
    expect(limited.reads).toEqual([`${API}${path}`]);
  });

  it("lists shipments and reconciliations by their time, both days included, for the store's client id", async () => {
    const mock = jmShippingDocMock(store());
    expect(await body(get(mock, "/shipment/list/4321/2026-10-01/2026-10-02"))).toEqual({ Error: null, ShipmentGids: [gid(1), gid(2)] });
    expect(await body(get(mock, "/shipment/list/4321/2026-10-01/2026-10-03"))).toEqual({ Error: null, ShipmentGids: [1, 2, 3, 4, 5, 6].map(gid) });
    expect(jmShippingBoughtAt(3)).toBe("2026-10-02T03:00:00.000Z");
    expect(await body(get(mock, "/shipment/list/4321/2026-10-01/2026-10-01"))).toEqual({ Error: null, ShipmentGids: [] });
    const midnight = jmShippingDocMock(store({ shipments: [shipment(1, { TransactionTime: "2026-10-02T00:00:00Z" })] }));
    expect(await body(get(midnight, "/shipment/list/4321/2026-10-01/2026-10-02"))).toEqual({ Error: null, ShipmentGids: [gid(1)] });
    expect(await body(get(midnight, "/shipment/list/4321/2026-10-02/2026-10-03"))).toEqual({ Error: null, ShipmentGids: [gid(1)] });
    expect(await body(get(mock, "/shipment/list/4321/2026-10-02/2026-10-01"))).toEqual({ Error: [{ ErrorCode: "400", ErrorMessage: "Start date must be before end date" }], ShipmentGids: [] });
    for (const path of ["/shipment/list/1/2026-10-01/2026-10-02", "/shipment/reconciliation/1/2026-10-01/2026-10-02"]) expect(await body(get(mock, path)), path).toEqual({ Message: "Client not accessible" });
    for (const path of ["/shipment/list/4321/2026-10-01T00:00:00Z/2026-10-02", "/shipment/list/4321/2026-10-01/2026-99-99", "/shipment/reconciliation/4321/10-01-2026/2026-10-02"]) {
      const r = await get(mock, path);
      expect(r.status, path).toBe(400);
      expect(await r.json()).toEqual({ Message: "Dates must be YYYY-MM-DD" });
    }
    const rec = async (path: string) => ((await body(get(mock, path))) as { ShipmentGid: string }[]).map((r) => r.ShipmentGid);
    expect(await rec("/shipment/reconciliation/4321/2026-10-08/2026-10-09")).toEqual([gid(1), gid(2)]);
    expect(await rec("/shipment/reconciliation/4321/2026-10-09/2026-10-10")).toEqual([gid(3)]);
    expect(await rec("/shipment/reconciliation/4321/2026-10-10/2026-10-11")).toEqual([]);
  });

  it("answers shipments and tracking by GUID or id, the latest activity or all of them", async () => {
    const mock = jmShippingDocMock(store());
    const found = (await body(get(mock, `/shipment/${gid(2).toUpperCase()},70001,${gid(99)}`))) as { Shipment: { Gid: string } }[];
    expect(found.map((s) => s.Shipment.Gid)).toEqual([gid(2), gid(1)]);
    expect(await body(get(mock, "/shipment/x,70001"))).toEqual({ Message: "ids must be shipment ids or GUIDs" });
    const latest = (await body(get(mock, `/shipment/track/latest/${gid(1)}`))) as { Activities: { tgActivityCode: number }[] }[];
    expect(latest[0]!.Activities.map((a) => a.tgActivityCode)).toEqual([89]);
    const full = (await body(get(mock, `/shipment/track/full/70001`))) as { Activities: unknown[] }[];
    expect(full[0]!.Activities).toHaveLength(2);
    expect(await body(get(mock, `/shipment/track/some/${gid(1)}`))).toEqual({ Message: "fullHistory must be full or latest" });
    expect(await body(get(mock, `/shipment/track/latest/0`))).toEqual({ Message: "ids must be shipment ids or GUIDs" });
    const bare = jmShippingDocMock(store({ tracking: [tracking(1, { Activities: null })] }));
    expect(await body(get(bare, `/shipment/track/latest/${gid(1)}`))).toEqual([tracking(1, { Activities: null })]);
  });

  it("answers a claim, a zero-id claim for a shipment without one, and 404 for a shipment it doesn't know", async () => {
    const mock = jmShippingDocMock(store());
    expect(((await body(get(mock, `/claim/${gid(2)}`))) as { Claim: { Id: number } }).Claim.Id).toBe(90002);
    expect(((await body(get(mock, `/claim/70005`))) as { Claim: { Id: number } }).Claim.Id).toBe(90005);
    expect(((await body(get(mock, `/claim/${gid(1)}`))) as { Claim: { Id: number }; Error: unknown[] })).toMatchObject({ Claim: { Id: 0 }, Error: [] });
    const missing = await get(mock, `/claim/${gid(99)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ Message: "Claim not found" });
  });

  it("turns down requests the docs don't document", async () => {
    const mock = jmShippingDocMock(store());
    await expect(mock.fetch(`${JM_SHIPPING_UAT_BASE}${API}/shipment/${gid(1)}`, { method: "DELETE", headers: headers() })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${JM_SHIPPING_UAT_BASE}${API}/shipment/quote`, { method: "POST", body: "{}", headers: headers() })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${JM_SHIPPING_UAT_BASE}${API}/shipment/daily-report/4321/x`, { headers: headers() })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`https://api.transguardian.com${API}/claim/${gid(1)}`, { headers: headers() })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
