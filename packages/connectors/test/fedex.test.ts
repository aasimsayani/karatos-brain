import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, checkConnectorSync, fedexDelivered, fedexDocMock, fedexResult, fedexTrackingNumber, testPipeline, type FedexMock, type FedexMockData } from "@karatos/connector-testkit";
import {
  FEDEX_HOSTS,
  FEDEX_TRACKING_NUMBER,
  FEDEX_WRITES,
  FedexApiError,
  FedexConfigError,
  fedexClient,
  fedexConnector,
  fedexDay,
  fedexPackages,
  fedexStatus,
  fedexTime,
  fedexTrackingNumbersFromFile,
  type FedexOptions,
  type ShipmentEvent,
  type TrackingCursor,
} from "../src/index.js";

const NOW = () => new Date("2026-11-10T12:00:00Z");
const RECEIVED = "2026-11-10T12:00:00.000Z";
// Shaped like a FedEx API key and secret, assembled so no scanner mistakes them for real ones.
const ID = ["test", "0".repeat(20)].join("");
const SECRET = ["test", "1".repeat(28)].join("");
const noSleep = async () => {};

const N = [1, 2, 3, 4].map(fedexTrackingNumber);
const EXCEPTION = fedexResult.one({ trackingNumberInfo: { trackingNumber: N[2] }, latestStatusDetail: { code: "DE", derivedCode: "DE", statusByLocale: "Delivery exception", description: "Customer not available or business closed" }, specialHandlings: [] });
const data = (extra: Partial<FedexMockData> = {}): FedexMockData => ({
  clientId: ID,
  clientSecret: SECRET,
  results: { [N[0]!]: fedexResult.one({ trackingNumberInfo: { trackingNumber: N[0] } }), [N[1]!]: fedexDelivered(2), [N[2]!]: EXCEPTION },
  ...extra,
});

function connector(mock: FedexMock = fedexDocMock(data()), extra: Partial<FedexOptions> = {}) {
  return fedexConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, trackingNumbers: async () => [...N], batchSize: 2, now: NOW, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as ShipmentEvent[]);

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const TOKEN = { access_token: "a".repeat(32), expires_in: 3599 };
const tracked = (trackResults: unknown[]) => ({ output: { completeTrackResults: [{ trackingNumber: N[0], trackResults }] } });

function scripted(answers: (() => Response)[]) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
const client = (s: { fetch: typeof globalThis.fetch }, extra = {}) => fedexClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch, sleep: noSleep, ...extra });

describe("FedEx client", () => {
  it("signs in with the client credentials form, then tracks one number a call with a fresh transaction id", async () => {
    const mock = fedexDocMock(data());
    const c = fedexClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch });
    expect(await c.track(N[0]!)).toMatchObject({ kind: "found" });
    expect(await c.track(N[1]!)).toMatchObject({ kind: "found" });
    expect(mock.operations).toEqual(["token", `track:${N[0]}`, `track:${N[1]}`]);
    expect(new Set(mock.transactionIds).size).toBe(2);
    expect(mock.transactionIds.every((t) => /^[0-9a-f]{32}$/.test(t))).toBe(true);
    expect(mock.fetch.calls).toEqual([
      { method: "POST", url: `${FEDEX_HOSTS.production}/oauth/token` },
      { method: "POST", url: `${FEDEX_HOSTS.production}/track/v1/trackingnumbers` },
      { method: "POST", url: `${FEDEX_HOSTS.production}/track/v1/trackingnumbers` },
    ]);
  });

  it("sends the headers and body FedEx asks for, with no detailed scans", async () => {
    const s = scripted([() => respond(200, TOKEN), () => respond(200, tracked([{ trackingNumberInfo: { trackingNumber: N[0] } }]))]);
    await client(s, { environment: "test" }).track(N[0]!);
    const [token, track] = s.calls;
    expect(token!.url).toBe("https://apis-sandbox.fedex.com/oauth/token");
    expect(token!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(token!.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(token!.body))).toEqual({ grant_type: "client_credentials", client_id: ID, client_secret: SECRET });
    expect(track!.url).toBe("https://apis-sandbox.fedex.com/track/v1/trackingnumbers");
    expect(track!.headers.get("authorization")).toBe(`Bearer ${TOKEN.access_token}`);
    expect(track!.headers.get("content-type")).toBe("application/json");
    expect(track!.headers.get("accept")).toBe("application/json");
    expect(track!.headers.get("x-locale")).toBe("en_US");
    expect(JSON.parse(track!.body)).toEqual({ includeDetailedScans: false, trackingInfo: [{ trackingNumberInfo: { trackingNumber: N[0] } }] });
  });

  it("keeps the token until five minutes before it runs out, and reads only a whole number of seconds", async () => {
    let at = Date.parse("2026-11-10T12:00:00Z");
    const mock = fedexDocMock(data({ expiresIn: 600 }));
    const c = fedexClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, now: () => new Date(at) });
    await c.track(N[0]!);
    at += 299_000;
    await c.track(N[0]!);
    expect(mock.tokens).toHaveLength(1);
    at += 1_000;
    await c.track(N[0]!);
    expect(mock.tokens).toHaveLength(2);
    for (const expires_in of ["soon", -5, "", null, 12_345_678, 3600.5, [3600], true]) {
      const s = scripted([() => respond(200, { ...TOKEN, expires_in }), () => respond(404, {}), () => respond(200, TOKEN), () => respond(404, {})]);
      const c2 = client(s);
      await c2.track(N[0]!);
      await c2.track(N[0]!);
      expect([expires_in, s.calls.filter((x) => x.url.endsWith("/token")).length]).toEqual([expires_in, 2]);
    }
    const s = scripted([() => respond(200, { ...TOKEN, expires_in: "3600" }), () => respond(404, {}), () => respond(404, {})]);
    const c3 = client(s);
    await c3.track(N[0]!);
    await c3.track(N[0]!);
    expect(s.calls.filter((x) => x.url.endsWith("/token"))).toHaveLength(1);
  });

  it("signs in again once on a 401, and stops on a second or a 403", async () => {
    const revoked = fedexDocMock(data({ revoked: new Set(["testtoken000000000001"]) }));
    expect(await fedexClient({ clientId: ID, clientSecret: SECRET, fetch: revoked.fetch }).track(N[0]!)).toMatchObject({ kind: "found" });
    expect(revoked.operations).toEqual(["token", "token", `track:${N[0]}`]);
    const twice = scripted([() => respond(200, TOKEN), () => respond(401, {}), () => respond(200, TOKEN), () => respond(401, { errors: [{ code: "NOT.AUTHORIZED.ERROR" }] })]);
    await expect(client(twice).track(N[0]!)).rejects.toMatchObject({ name: "FedexApiError", status: 401, code: "NOT.AUTHORIZED.ERROR", message: expect.stringMatching(/Track API/) });
    expect(twice.calls).toHaveLength(4);
    const forbidden = scripted([() => respond(200, TOKEN), () => respond(403, { errors: [{ code: "FORBIDDEN.ERROR" }] })]);
    await expect(client(forbidden).track(N[0]!)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN.ERROR", message: expect.stringMatching(/^FedEx turned down the token for tracking/) });
    expect(forbidden.calls).toHaveLength(2);
  });

  it("reads a number FedEx has nothing for as not found, whether as an error on its result, no results or a 404", async () => {
    const mock = fedexDocMock(data());
    expect(await fedexClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch }).track(N[3]!)).toEqual({ kind: "not_found" });
    for (const body of [tracked([]), { output: {} }, {}, { output: { completeTrackResults: [null, { trackResults: "x" }] } }, tracked([{ error: { code: "TRACKING.TRACKINGNUMBER.NOTFOUND" } }, null, 5])]) {
      expect(await client(scripted([() => respond(200, TOKEN), () => respond(200, body)])).track(N[0]!)).toEqual({ kind: "not_found" });
    }
    expect(await client(scripted([() => respond(200, TOKEN), () => respond(404, "")])).track(N[0]!)).toEqual({ kind: "not_found" });
    const mixed = await client(scripted([() => respond(200, TOKEN), () => respond(200, tracked([{ error: { code: "X" } }, { trackingNumberInfo: { trackingNumber: N[0] } }]))])).track(N[0]!);
    expect(mixed).toEqual({ kind: "found", results: [{ trackingNumberInfo: { trackingNumber: N[0] } }] });
    // Only an error object marks a result as empty; a null or a stray value doesn't.
    const nulls = await client(scripted([() => respond(200, TOKEN), () => respond(200, tracked([{ error: null }, { error: "" }, { error: "x" }]))])).track(N[0]!);
    expect(nulls).toEqual({ kind: "found", results: [{ error: null }, { error: "" }, { error: "x" }] });
  });

  it("waits out a 429 or 503 as Retry-After says, capped at a minute, then backs off, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = fedexDocMock(data({ throttle: 1, outage: 1 }));
    expect(await fedexClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep }).track(N[0]!)).toMatchObject({ kind: "found" });
    expect(waits).toEqual([2000, 2000]);
    waits.length = 0;
    const s = scripted([() => respond(200, TOKEN), () => respond(429, {}, { "retry-after": "600" }), () => respond(503, {}, { "retry-after": "soon" }), () => respond(429, {}, { "retry-after": "1e1" }), () => respond(503, { errors: [{ code: "SERVICE.UNAVAILABLE.ERROR" }] })]);
    await expect(client(s, { sleep }).track(N[0]!)).rejects.toMatchObject({ status: 503, code: "SERVICE.UNAVAILABLE.ERROR", message: "FedEx tracking answered HTTP 503" });
    expect(waits).toEqual([60_000, 2000, 4000]);
    waits.length = 0;
    await expect(client(scripted([() => respond(429, {}), () => respond(429, {})]), { sleep, retries: 1 }).track(N[0]!)).rejects.toMatchObject({ status: 429, message: "FedEx sign-in answered HTTP 429" });
    expect(waits).toEqual([1000]);
  });

  it("answers a wrong key or secret with a clear error that never shows the secret", async () => {
    const mock = fedexDocMock({ ...data(), clientSecret: ["test", "2".repeat(28)].join("") });
    const error = await fedexClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch })
      .track(N[0]!)
      .then(
        () => null,
        (e: unknown) => e as FedexApiError,
      );
    expect(error).toBeInstanceOf(FedexApiError);
    expect(error).toMatchObject({ status: 401, code: "NOT.AUTHORIZED.ERROR", message: expect.stringMatching(/^FedEx turned down the API key and secret: check FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET/) });
    expect(error!.message).not.toContain(SECRET);
    await expect(client(scripted([() => respond(403, "<html>")])).track(N[0]!)).rejects.toMatchObject({ status: 403, code: undefined, message: expect.stringMatching(/^FedEx turned down the API key/) });
    // A secret with characters a form must escape still signs in.
    const odd = ["test", "&=+%".repeat(4)].join("");
    expect(await fedexClient({ clientId: ID, clientSecret: odd, fetch: fedexDocMock({ ...data(), clientSecret: odd }).fetch }).track(N[0]!)).toMatchObject({ kind: "found" });
  });

  it("stops on a sign-in or tracking answer it can't use, keeping only a code that reads as one", async () => {
    for (const [status, body, message] of [
      [500, { errors: [{ code: "INTERNAL.SERVER.ERROR" }] }, "FedEx sign-in answered HTTP 500"],
      [200, { expires_in: 100 }, "FedEx sign-in answered without an access token"],
      [200, { access_token: "short" }, "FedEx sign-in answered without an access token"],
      [200, { access_token: `${"a".repeat(20)} ${"b".repeat(20)}` }, "FedEx sign-in answered without an access token"],
      [200, "<html>", "FedEx sign-in answered without an access token"],
      [200, [TOKEN], "FedEx sign-in answered without an access token"],
    ] as const) {
      await expect(client(scripted([() => respond(status, body)])).track(N[0]!)).rejects.toThrow(message);
    }
    for (const [status, body, message, code] of [
      [400, { errors: [{ code: "TRACKING.TRACKINGNUMBER.INVALID" }] }, "FedEx tracking answered HTTP 400", "TRACKING.TRACKINGNUMBER.INVALID"],
      [500, { errors: [{ code: "lower.case" }] }, "FedEx tracking answered HTTP 500", undefined],
      [500, { errors: [{ code: "A".repeat(81) }] }, "FedEx tracking answered HTTP 500", undefined],
      [500, { errors: [{ code: 7 }] }, "FedEx tracking answered HTTP 500", undefined],
      [500, { errors: { 0: { code: "X" } } }, "FedEx tracking answered HTTP 500", undefined],
      [500, { errors: [null] }, "FedEx tracking answered HTTP 500", undefined],
      [500, [{ errors: [{ code: "X" }] }], "FedEx tracking answered HTTP 500", undefined],
      [200, "<html>", "FedEx tracking answered with a body that isn't a JSON object", undefined],
      [200, [1], "FedEx tracking answered with a body that isn't a JSON object", undefined],
      [200, null, "FedEx tracking answered with a body that isn't a JSON object", undefined],
    ] as const) {
      const error = await client(scripted([() => respond(200, TOKEN), () => respond(status, body)]))
        .track(N[0]!)
        .then(
          () => null,
          (e: unknown) => e as FedexApiError,
        );
      expect([error?.message, error?.code]).toEqual([message, code]);
    }
    expect(await client(scripted([() => respond(200, TOKEN), () => respond(200, { output: { completeTrackResults: [{ trackResults: [{ a: 1 }] }] } })])).track(N[0]!)).toEqual({ kind: "found", results: [{ a: 1 }] });
    expect(await client(scripted([() => respond(200, TOKEN), () => respond(200, { output: [] })])).track(N[0]!)).toEqual({ kind: "not_found" });
  });

  it("checks its settings and the numbers it is given before sending anything", async () => {
    const s = scripted([]);
    const make = (o: object) => () => fedexClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch, ...o });
    expect(make({ clientId: "short" })).toThrow(FedexConfigError);
    expect(make({ clientId: `${ID}/x` })).toThrow(/FEDEX_CLIENT_ID/);
    expect(make({ clientId: "a".repeat(129) })).toThrow(/FEDEX_CLIENT_ID/);
    expect(make({ clientId: "a".repeat(128) })).not.toThrow();
    expect(make({ clientSecret: "short" })).toThrow(/FEDEX_CLIENT_SECRET/);
    expect(make({ clientSecret: `${SECRET} x` })).toThrow(/FEDEX_CLIENT_SECRET/);
    expect(make({ clientSecret: "a".repeat(257) })).toThrow(/FEDEX_CLIENT_SECRET/);
    expect(make({ clientSecret: "a".repeat(256) })).not.toThrow();
    expect(make({ environment: "staging" })).toThrow(/FEDEX_ENVIRONMENT/);
    expect(make({ environment: "toString" })).toThrow(/FEDEX_ENVIRONMENT/);
    for (const bad of ["12345678901", "1".repeat(35), "DT1234567890", "DT12345678901", "dt123456789012", "12345678901a", `${N[0]}\n`]) {
      await expect(make({})().track(bad)).rejects.toThrow(/not a FedEx tracking number/);
    }
    expect(s.calls).toHaveLength(0);
    for (const good of ["123456789012", "1".repeat(34), "DT123456789012"]) expect(FEDEX_TRACKING_NUMBER.test(good)).toBe(true);
  });
});

describe("FedEx normalizer", () => {
  it("maps FedEx's status codes, preferring the derived code", () => {
    const cases: [unknown, string][] = [
      [{ code: "OC" }, "label_created"],
      [{ code: "IN" }, "label_created"],
      [{ code: "PU" }, "picked_up"],
      [{ code: "PX" }, "picked_up"],
      ...["IT", "AR", "DP", "AF", "AP", "CC", "HL"].map((code): [unknown, string] => [{ code }, "in_transit"]),
      [{ code: "OD" }, "out_for_delivery"],
      [{ code: "DL" }, "delivered"],
      ...["DE", "SE", "CA", "DY"].map((code): [unknown, string] => [{ code }, "exception"]),
      [{ code: "RS" }, "returned"],
      [{ code: " dl " }, "delivered"],
      [{ code: "AR", derivedCode: "DL" }, "delivered"],
      [{ code: "DL", derivedCode: "  " }, "delivered"],
      [{ code: "DL", derivedCode: 5 }, "delivered"],
      [{ code: "DL", derivedCode: "ZZ" }, "unknown"],
      [{ code: "constructor" }, "unknown"],
      [{}, "unknown"],
      [null, "unknown"],
      ["DL", "unknown"],
    ];
    for (const [latest, status] of cases) expect([latest, fedexStatus(latest)]).toEqual([latest, status]);
  });

  it("reads FedEx times with their offsets as UTC, and their days as written", () => {
    expect(fedexTime("2026-11-02T06:47:00-06:00")).toBe("2026-11-02T12:47:00.000Z");
    expect(fedexTime("2026-11-02T23:30:00+05:30")).toBe("2026-11-02T18:00:00.000Z");
    expect(fedexTime("2026-11-02T12:47:00Z")).toBe("2026-11-02T12:47:00.000Z");
    expect(fedexTime("2026-11-02T12:47:00.250Z")).toBe("2026-11-02T12:47:00.250Z");
    for (const bad of [" 2026-11-02T12:47:00Z", "2026-11-02T24:00:00Z", "2026-11-02T24:00:00+06:00", "2026-02-30T00:00:00-06:00", "2026-11-02T25:00:00-06:00", "2026-11-02T12:60:00Z", "2026-11-02 12:47:00Z", "2026-11-02T12:47:00", "2026-11-02T12:47:00-0600", "x2026-11-02T12:47:00Z", "2026-11-02T12:47:00Zx", "2026-11-02T12:47:00+24:00", "2026-11-02T12:47:00-06:60"]) {
      expect([bad, fedexTime(bad)]).toEqual([bad, undefined]);
    }
    expect(fedexTime(5)).toBeUndefined();
    expect(fedexDay("2026-11-04T23:30:00-06:00")).toBe("2026-11-04");
    expect(fedexDay("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(fedexDay(null)).toBeUndefined();
  });

  it("keeps what helps and leaves out names, addresses, declared values and proof of delivery", () => {
    const [moving] = fedexPackages([fedexResult.one({ trackingNumberInfo: { trackingNumber: N[0] } })]);
    expect(moving).toEqual({
      trackingNumber: N[0],
      status: "in_transit",
      carrierStatus: "IT",
      description: "In transit",
      lastEventAt: "2026-11-02T12:47:00.000Z",
      estimatedDelivery: "2026-11-04",
      deliveredAt: undefined,
      service: "FedEx 2Day",
      signatureRequired: true,
      destinationState: "TX",
      destinationCountry: "US",
    });
    const [delivered] = fedexPackages([fedexDelivered(2, { estimatedDeliveryTimeWindow: { window: { ends: "2026-11-05T20:00:00-06:00" } } })]);
    expect(delivered).toMatchObject({ status: "delivered", deliveredAt: "2026-11-04", estimatedDelivery: undefined, carrierStatus: "DL" });
    const text = JSON.stringify(delivered);
    for (const kept of ["Test Receiver", "T.RECEIVER", "Front desk", "2 Example Avenue", "78701", "AUSTIN", "2500", "SIGNATURE_PROOF", "MEMPHIS", "Test Shipper"]) expect(text).not.toContain(kept);
  });

  it("takes the estimated day from the dates, then the window's end, then its start", () => {
    const est = (r: object, code = "IT") => fedexPackages([{ trackingNumberInfo: { trackingNumber: N[0] }, latestStatusDetail: { code }, ...r }])[0]!;
    expect(est({ dateAndTimes: [{ type: "ESTIMATED_DELIVERY", dateTime: "2026-11-04T10:30:00-06:00" }], estimatedDeliveryTimeWindow: { window: { ends: "2026-11-06T10:30:00-06:00" } } }).estimatedDelivery).toBe("2026-11-04");
    expect(est({ estimatedDeliveryTimeWindow: { window: { begins: "2026-11-05T08:00:00-06:00", ends: "2026-11-06T10:30:00-06:00" } } }).estimatedDelivery).toBe("2026-11-06");
    expect(est({ estimatedDeliveryTimeWindow: { window: { begins: "2026-11-05T08:00:00-06:00" } } }).estimatedDelivery).toBe("2026-11-05");
    expect(est({ dateAndTimes: [{ type: "ESTIMATED_DELIVERY", dateTime: "bad" }, null, { type: "SHIP", dateTime: "2026-11-01T00:00:00-05:00" }] }).estimatedDelivery).toBeUndefined();
    expect(est({ dateAndTimes: [{ type: "ACTUAL_DELIVERY", dateTime: "2026-11-04T10:30:00-06:00" }] })).toMatchObject({ deliveredAt: undefined, estimatedDelivery: undefined });
    expect(est({ dateAndTimes: [{ type: "ESTIMATED_DELIVERY", dateTime: "2026-11-04T10:30:00-06:00" }] }, "DL")).toMatchObject({ deliveredAt: undefined, estimatedDelivery: undefined });
    expect(est({ dateAndTimes: "x", estimatedDeliveryTimeWindow: "x" })).toMatchObject({ estimatedDelivery: undefined });
  });

  it("picks the latest scan whatever the order, skipping ones that don't read", () => {
    const at = (scanEvents: unknown) => fedexPackages([{ trackingNumberInfo: { trackingNumber: N[0] }, scanEvents }])[0]!.lastEventAt;
    expect(at([{ date: "2026-11-01T17:10:00-05:00" }, { date: "2026-11-02T06:47:00-06:00" }, { date: "soon" }, null])).toBe("2026-11-02T12:47:00.000Z");
    expect(at([{ date: "2026-11-02T06:47:00-06:00" }, { date: "2026-11-01T17:10:00-05:00" }])).toBe("2026-11-02T12:47:00.000Z");
    expect(at(undefined)).toBeUndefined();
  });

  it("reads the destination's state and country, a signature, the service and FedEx's text", () => {
    const one = (r: object) => fedexPackages([{ trackingNumberInfo: { trackingNumber: N[0] }, ...r }])[0]!;
    expect(one({ recipientInformation: { address: { stateOrProvinceCode: " on ", countryCode: " ca " } } })).toMatchObject({ destinationState: "ON", destinationCountry: "CA" });
    expect(one({ recipientInformation: { address: { stateOrProvinceCode: "Texas", countryCode: "USA" } } })).toMatchObject({ destinationState: undefined, destinationCountry: undefined });
    expect(one({ recipientInformation: { address: { stateOrProvinceCode: "T", countryCode: 1 } } })).toMatchObject({ destinationState: undefined, destinationCountry: undefined });
    expect(one({ recipientInformation: "x" })).toMatchObject({ destinationState: undefined });
    for (const type of ["DIRECT_SIGNATURE_REQUIRED", "ADULT_SIGNATURE_REQUIRED", "INDIRECT_SIGNATURE_REQUIRED", "SIGNATURE_OPTION"]) expect(one({ specialHandlings: [{ type: "DELIVER_WEEKDAY" }, { type }] }).signatureRequired).toBe(true);
    expect(one({ specialHandlings: [{ type: "DELIVER_WEEKDAY" }, null, "DIRECT_SIGNATURE_REQUIRED"] }).signatureRequired).toBeUndefined();
    expect(one({ specialHandlings: { type: "ADULT_SIGNATURE_REQUIRED" } }).signatureRequired).toBeUndefined();
    expect(one({ serviceDetail: { description: "s".repeat(100) } }).service).toHaveLength(80);
    expect(one({ latestStatusDetail: { statusByLocale: "  In \n transit ", description: "x" } }).description).toBe("In transit");
    expect(one({ latestStatusDetail: { statusByLocale: " ", description: "At local FedEx facility" } }).description).toBe("At local FedEx facility");
    expect(one({ latestStatusDetail: { description: "d".repeat(300) } }).description).toHaveLength(200);
    expect(one({ latestStatusDetail: { code: "ab" } }).carrierStatus).toBe("AB");
    expect(one({ latestStatusDetail: { code: "ABCDE" } }).carrierStatus).toBeUndefined();
    expect(one({ latestStatusDetail: { code: "A-" } }).carrierStatus).toBeUndefined();
    expect(one({ latestStatusDetail: { code: 5 } }).carrierStatus).toBeUndefined();
  });

  it("skips results without a usable number", () => {
    const results = [{ trackingNumberInfo: { trackingNumber: ` ${N[0]!.slice(0, 6)} ${N[0]!.slice(6)} ` } }, { trackingNumberInfo: { trackingNumber: "dt123456789012" } }, { trackingNumberInfo: { trackingNumber: "12" } }, { trackingNumberInfo: { trackingNumber: 5 } }, { trackingNumberInfo: "x" }, null, "x"];
    expect(fedexPackages(results).map((p) => p.trackingNumber)).toEqual([N[0], "DT123456789012"]);
  });
});

describe("FedEx connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data());
  });

  it("has nothing to write back", () => {
    expect(FEDEX_WRITES).toEqual([]);
    expect(connector().writes).toEqual([]);
    expect(connector().source).toBe("fedex");
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 3 } });
    expect(result.full.batches).toBe(2);
    expect(result.replay.duplicates).toBe(3);
    expect(JSON.parse(result.full.cursor!) as TrackingCursor).toEqual({ final: [N[1]], firstSeen: Object.fromEntries(N.map((n) => [n, RECEIVED])), read: [] });
  });

  it("records a package in transit, one delivered and an exception, as fedex events", async () => {
    const events = await eventsOf();
    expect(events.map((e) => [e.id.slice(0, 6), e.idempotencyKey.slice(0, 6), e.payload.carrier, e.payload.trackingNumber, e.payload.status])).toEqual([
      ["fedex_", "fedex:", "fedex", N[0], "in_transit"],
      ["fedex_", "fedex:", "fedex", N[1], "delivered"],
      ["fedex_", "fedex:", "fedex", N[2], "exception"],
    ]);
    expect(events[1]!.payload).toMatchObject({ deliveredAt: "2026-11-04", shipmentId: `fedex:package:${N[1]}` });
    expect(events[2]!.payload).toMatchObject({ carrierStatus: "DE", description: "Delivery exception" });
  });

  it("stops reading a delivered package and reads the rest again on the next sync", async () => {
    const mock = fedexDocMock(data());
    const { memory, pipeline } = testPipeline();
    const c = connector(mock);
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 3 });
    mock.operations.length = 0;
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 2 });
    expect(mock.operations).toEqual([`track:${N[0]}`, `track:${N[2]}`, `track:${N[3]}`]);
  });

  it("reads at most 500 numbers a sync, 25 to a checkpoint, by default, and reads its list from a file", async () => {
    const asked: string[] = [];
    const many = Array.from({ length: 501 }, (_, i) => fedexTrackingNumber(100 + i));
    const c = fedexConnector({ clientId: ID, clientSecret: SECRET, trackingNumbers: async () => many, now: NOW, client: { track: async (n) => (asked.push(n), { kind: "not_found" }) } });
    expect(await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).toHaveLength(20);
    expect(asked).toHaveLength(500);
    const list = fedexTrackingNumbersFromFile("/lists/fedex.txt", async () => `# list\n${N[0]}, dt123456789012 12345\n`);
    expect(await list()).toEqual([N[0], "DT123456789012"]);
  });

  it("drops a number that never moves after 120 days", async () => {
    const mock = fedexDocMock(data());
    const cursor: TrackingCursor = { final: [], read: [], firstSeen: { [N[0]!]: "2026-07-12T12:00:00.000Z", [N[2]!]: "2026-07-13T12:00:00.000Z" } };
    await collect(connector(mock, { trackingNumbers: async () => [N[0]!, N[2]!] }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) }));
    expect(mock.operations).toEqual(["token", `track:${N[2]}`]);
  });
});
