import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, checkConnectorSync, testPipeline, upsDelivered, upsDocMock, upsPackage, upsTrackingNumber, type UpsMock, type UpsMockData } from "@karatos/connector-testkit";
import {
  FINAL_STATUSES,
  MAX_TRACKING_NUMBERS,
  UPS_HOSTS,
  UPS_TRACKING_NUMBER,
  UPS_WRITES,
  UpsApiError,
  UpsConfigError,
  parseTrackingCursor,
  parseTrackingNumbers,
  shipmentEvent,
  trackingConnector,
  upsClient,
  upsConnector,
  upsDate,
  upsPackages,
  upsStatus,
  upsTime,
  upsTrackingNumbersFromFile,
  type ShipmentEvent,
  type TrackingCursor,
  type UpsOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-11-10T12:00:00Z");
const RECEIVED = "2026-11-10T12:00:00.000Z";
// Shaped like a UPS client id and secret, assembled so no scanner mistakes them for real ones.
const ID = ["test", "0".repeat(20)].join("");
const SECRET = ["test", "1".repeat(40)].join("");
const noSleep = async () => {};

const N = [1, 2, 3, 4, 5].map(upsTrackingNumber);
const EXCEPTION = upsPackage.one({ trackingNumber: N[2], currentStatus: { code: "X1", description: "Damaged, the receiver turned it down", simplifiedTextDescription: "Delivery Exception", statusCode: "007", type: "X" }, additionalServices: [] });
const data = (extra: Partial<UpsMockData> = {}): UpsMockData => ({
  clientId: ID,
  clientSecret: SECRET,
  packages: { [N[0]!]: upsPackage.one({ trackingNumber: N[0] }), [N[1]!]: upsDelivered(2), [N[2]!]: EXCEPTION },
  warnings: [N[3]!],
  ...extra,
});
// N[3] answers only a warning and N[4] isn't known at all.
const LIST = [...N];

function connector(mock: UpsMock = upsDocMock(data()), extra: Partial<UpsOptions> = {}) {
  return upsConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, trackingNumbers: async () => LIST, batchSize: 2, now: NOW, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const lastCursor = (batches: SourceBatch[]) => batches[batches.length - 1]!.cursor;
const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as ShipmentEvent[]);

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const TOKEN = { access_token: "a".repeat(32), expires_in: "14399" };

/** A fetch that answers each call from the list in turn, recording what was asked. */
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

describe("UPS client", () => {
  it("signs in with Basic auth and the client credentials form, then tracks with a bearer token and a fresh transId", async () => {
    const mock = upsDocMock(data());
    const client = upsClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch });
    expect(await client.track(N[0]!)).toMatchObject({ kind: "found" });
    expect(await client.track(N[1]!)).toMatchObject({ kind: "found" });
    expect(mock.operations).toEqual(["token", `track:${N[0]}`, `track:${N[1]}`]);
    expect(mock.transIds).toHaveLength(2);
    expect(new Set(mock.transIds).size).toBe(2);
    expect(mock.transIds.every((t) => /^[0-9a-f]{32}$/.test(t))).toBe(true);
    expect(mock.fetch.calls).toEqual([
      { method: "POST", url: `${UPS_HOSTS.production}/security/v1/oauth/token` },
      { method: "GET", url: `${UPS_HOSTS.production}/api/track/v1/details/${N[0]}?locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false` },
      { method: "GET", url: `${UPS_HOSTS.production}/api/track/v1/details/${N[1]}?locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false` },
    ]);
  });

  it("sends the headers UPS asks for", async () => {
    const s = scripted([() => respond(200, TOKEN), () => respond(200, { trackResponse: { shipment: [] } })]);
    await upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch, environment: "test" }).track(N[0]!);
    const [token, track] = s.calls;
    expect(token!.url).toBe("https://wwwcie.ups.com/security/v1/oauth/token");
    expect(token!.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`);
    expect(token!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(token!.headers.get("accept")).toBe("application/json");
    expect(token!.body).toBe("grant_type=client_credentials");
    expect(track!.url.startsWith("https://wwwcie.ups.com/api/track/v1/details/")).toBe(true);
    expect(track!.method).toBe("GET");
    expect(track!.headers.get("authorization")).toBe(`Bearer ${TOKEN.access_token}`);
    expect(track!.headers.get("transactionsrc")).toBe("karatos");
    expect(track!.headers.get("accept")).toBe("application/json");
  });

  it("keeps the token until five minutes before it runs out, then signs in again", async () => {
    let at = new Date("2026-11-10T12:00:00Z").getTime();
    const mock = upsDocMock(data({ expiresIn: "600" }));
    const client = upsClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, now: () => new Date(at) });
    await client.track(N[0]!);
    at += 299_000;
    await client.track(N[0]!);
    expect(mock.tokens).toHaveLength(1);
    at += 1_000;
    await client.track(N[0]!);
    expect(mock.tokens).toHaveLength(2);
  });

  it("treats an expires_in it can't read as already run out, and takes a number too", async () => {
    for (const expires_in of ["soon", "-5", "", null, "12345678", "3600.5", [3600], true]) {
      const s = scripted([() => respond(200, { ...TOKEN, expires_in }), () => respond(404, {}), () => respond(200, TOKEN), () => respond(404, {})]);
      const client = upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch });
      await client.track(N[0]!);
      await client.track(N[0]!);
      expect(s.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
    }
    const s = scripted([() => respond(200, { ...TOKEN, expires_in: 3600 }), () => respond(404, {}), () => respond(404, {})]);
    const client = upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch });
    await client.track(N[0]!);
    await client.track(N[0]!);
    expect(s.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
  });

  it("signs in again once on a 401, and stops on a second", async () => {
    // The first token the mock hands out is revoked, as when UPS ends one early.
    const revoked = upsDocMock(data({ revoked: new Set(["testtoken000000000001"]) }));
    const again = upsClient({ clientId: ID, clientSecret: SECRET, fetch: revoked.fetch });
    expect(await again.track(N[0]!)).toMatchObject({ kind: "found" });
    expect(revoked.operations).toEqual(["token", `track:${N[0]}`, "token", `track:${N[0]}`]);
    const s = scripted([() => respond(200, TOKEN), () => respond(401, { response: { errors: [{ code: "250002", message: "Invalid" }] } }), () => respond(200, TOKEN), () => respond(401, {})]);
    await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch }).track(N[0]!)).rejects.toMatchObject({ name: "UpsApiError", status: 401 });
    expect(s.calls).toHaveLength(4);
    const forbidden = scripted([() => respond(200, TOKEN), () => respond(403, { response: { errors: [{ code: "250003", message: "Blocked Merchant" }] } })]);
    await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: forbidden.fetch }).track(N[0]!)).rejects.toMatchObject({ status: 403, code: "250003", message: expect.stringMatching(/Tracking product/) });
    expect(forbidden.calls).toHaveLength(2);
  });

  it("answers an unknown number as not found", async () => {
    const client = upsClient({ clientId: ID, clientSecret: SECRET, fetch: upsDocMock(data()).fetch });
    expect(await client.track(N[4]!)).toEqual({ kind: "not_found" });
  });

  it("waits out a 429 or 503 as Retry-After says, capped at a minute, then backs off, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = upsDocMock(data({ throttle: 1, outage: 1 }));
    expect(await upsClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep }).track(N[0]!)).toMatchObject({ kind: "found" });
    expect(waits).toEqual([2000, 2000]);
    waits.length = 0;
    const s = scripted([
      () => respond(200, TOKEN),
      () => respond(429, {}, { "retry-after": "600" }),
      () => respond(503, {}, { "retry-after": "soon" }),
      () => respond(429, {}, { "retry-after": "1e1" }),
      () => respond(503, { response: { errors: [{ code: "10503", message: "down" }] } }),
    ]);
    await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch, sleep }).track(N[0]!)).rejects.toMatchObject({ status: 503, code: "10503", message: "UPS tracking answered HTTP 503" });
    expect(waits).toEqual([60_000, 2000, 4000]);
    waits.length = 0;
    const none = scripted([() => respond(429, {}), () => respond(429, {})]);
    await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: none.fetch, sleep, retries: 1 }).track(N[0]!)).rejects.toMatchObject({ status: 429, message: "UPS sign-in answered HTTP 429" });
    expect(waits).toEqual([1000]);
  });

  it("answers a wrong client id or secret with a clear error that never shows the secret", async () => {
    const mock = upsDocMock({ ...data(), clientSecret: ["test", "2".repeat(40)].join("") });
    const error = await upsClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch })
      .track(N[0]!)
      .then(
        () => null,
        (e: unknown) => e as UpsApiError,
      );
    expect(error).toBeInstanceOf(UpsApiError);
    expect(error).toMatchObject({ status: 401, code: "10401" });
    expect(error!.message).toMatch(/UPS_CLIENT_ID and UPS_CLIENT_SECRET/);
    expect(error!.message).not.toContain(SECRET);
    // A secret whose Basic value has a "/" in it, which base64url would write differently.
    const slashy = ["test", "?".repeat(12)].join("");
    expect(Buffer.from(`${ID}:${slashy}`).toString("base64")).toContain("/");
    const ok = upsDocMock({ ...data(), clientSecret: slashy });
    expect(await upsClient({ clientId: ID, clientSecret: slashy, fetch: ok.fetch }).track(N[0]!)).toMatchObject({ kind: "found" });
    const forbidden = scripted([() => respond(403, "not json")]);
    await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: forbidden.fetch }).track(N[0]!)).rejects.toMatchObject({ status: 403, code: undefined, message: expect.stringMatching(/^UPS turned down the client id and secret/) });
  });

  it("stops on a sign-in answer it can't use", async () => {
    for (const [status, body, message] of [
      [500, { response: { errors: [{ code: "10500", message: "x" }] } }, "UPS sign-in answered HTTP 500"],
      [200, { expires_in: "100" }, "UPS sign-in answered without an access token"],
      [200, { access_token: "short" }, "UPS sign-in answered without an access token"],
      [200, { access_token: `${"a".repeat(20)} ${"b".repeat(20)}` }, "UPS sign-in answered without an access token"],
      [200, "<html>", "UPS sign-in answered without an access token"],
      [200, [TOKEN], "UPS sign-in answered without an access token"],
    ] as const) {
      const s = scripted([() => respond(status, body)]);
      await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch }).track(N[0]!)).rejects.toThrow(message);
    }
    const s = scripted([() => respond(500, {})]);
    await expect(upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch }).track(N[0]!)).rejects.toMatchObject({ status: 500, code: undefined });
  });

  it("stops on a tracking answer it can't use, keeping only a short error code", async () => {
    for (const [status, body, message, code] of [
      [400, { response: { errors: [{ code: "TV0002", message: "bad" }] } }, "UPS tracking answered HTTP 400", "TV0002"],
      [500, { response: { errors: [{ code: "x".repeat(21) }] } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: { errors: [{ code: "has space" }] } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: { errors: [{ code: 7 }] } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: { errors: ["TV0002"] } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: { errors: "TV0002" } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: { errors: { 0: { code: "TV0002" } } } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: { errors: [null] } }, "UPS tracking answered HTTP 500", undefined],
      [500, { response: "TV0002" }, "UPS tracking answered HTTP 500", undefined],
      [200, "<html>", "UPS tracking answered with a body that isn't a JSON object", undefined],
      [200, [1], "UPS tracking answered with a body that isn't a JSON object", undefined],
      [200, null, "UPS tracking answered with a body that isn't a JSON object", undefined],
    ] as const) {
      const s = scripted([() => respond(200, TOKEN), () => respond(status, body)]);
      const error = await upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch })
        .track(N[0]!)
        .then(
          () => null,
          (e: unknown) => e as UpsApiError,
        );
      expect(error?.message).toBe(message);
      expect(error?.code).toBe(code);
    }
  });

  it("checks its settings and the numbers it is given before sending anything", async () => {
    const s = scripted([]);
    const make = (o: Partial<Parameters<typeof upsClient>[0]>) => () => upsClient({ clientId: ID, clientSecret: SECRET, fetch: s.fetch, ...o });
    expect(make({ clientId: "short" })).toThrow(UpsConfigError);
    expect(make({ clientId: `${ID}/x` })).toThrow(/UPS_CLIENT_ID/);
    expect(make({ clientId: "a".repeat(129) })).toThrow(/UPS_CLIENT_ID/);
    expect(make({ clientId: "a".repeat(128) })).not.toThrow();
    expect(make({ clientSecret: "short" })).toThrow(/UPS_CLIENT_SECRET/);
    expect(make({ clientSecret: `${SECRET} x` })).toThrow(/UPS_CLIENT_SECRET/);
    expect(make({ clientSecret: "a".repeat(257) })).toThrow(/UPS_CLIENT_SECRET/);
    expect(make({ clientSecret: "a".repeat(256) })).not.toThrow();
    expect(make({ environment: "staging" as never })).toThrow(/UPS_ENVIRONMENT/);
    expect(make({ environment: "toString" as never })).toThrow(/UPS_ENVIRONMENT/);
    for (const bad of ["1z12345e0205271688", "1Z1234", "1Z/../../security", "A".repeat(35), `${N[0]}?x=1`]) {
      await expect(make({})().track(bad)).rejects.toThrow(/not a UPS tracking number/);
    }
    expect(s.calls).toHaveLength(0);
  });
});

describe("UPS normalizer", () => {
  it("maps UPS's status types, reading out for delivery from the text", () => {
    const cases: [unknown, string][] = [
      [{ type: "D" }, "delivered"],
      [{ type: "I" }, "in_transit"],
      [{ type: "M" }, "label_created"],
      [{ type: "MV" }, "label_created"],
      [{ type: "P" }, "picked_up"],
      [{ type: "X" }, "exception"],
      [{ type: "RS" }, "returned"],
      [{ type: "O" }, "out_for_delivery"],
      [{ type: " d " }, "delivered"],
      [{ type: "I", simplifiedTextDescription: "Out For Delivery Today" }, "out_for_delivery"],
      [{ type: "I", description: "Out for delivery" }, "out_for_delivery"],
      [{ type: "X", description: "Out for delivery" }, "exception"],
      [{ type: "Q" }, "unknown"],
      [{ type: "constructor" }, "unknown"],
      [{ type: 4 }, "unknown"],
      [{}, "unknown"],
      [null, "unknown"],
      ["D", "unknown"],
    ];
    for (const [current, status] of cases) expect([current, upsStatus(current)]).toEqual([current, status]);
  });

  it("reads UPS days and times, padding times UPS writes without leading zeros", () => {
    expect(upsDate("20261104")).toBe("2026-11-04");
    expect(upsDate("20260230")).toBeUndefined();
    expect(upsDate("2026114")).toBeUndefined();
    expect(upsDate("x20261104")).toBeUndefined();
    expect(upsDate("202611041")).toBeUndefined();
    expect(upsDate(20261104)).toBeUndefined();
    expect(upsTime("20261102", "74700")).toBe("2026-11-02T07:47:00.000Z");
    expect(upsTime("20261102", "235959")).toBe("2026-11-02T23:59:59.000Z");
    expect(upsTime("20261102", "0")).toBe("2026-11-02T00:00:00.000Z");
    for (const bad of ["240000", "236000", "235960", "1234567", "", "12:00", "x12000"]) expect(upsTime("20261102", bad)).toBeUndefined();
    expect(upsTime("20261102", 120000)).toBeUndefined();
    expect(upsTime("2026-11-02", "120000")).toBeUndefined();
  });

  it("keeps what helps and leaves out names, addresses, signatures and proof of delivery", () => {
    const [moving] = upsPackages({ trackResponse: { shipment: [{ inquiryNumber: N[0], package: [upsPackage.one({ trackingNumber: N[0] })] }] } });
    expect(moving).toEqual({
      trackingNumber: N[0],
      status: "in_transit",
      carrierStatus: "IT",
      description: "On the Way",
      lastEventAt: "2026-11-02T12:47:00.000Z",
      estimatedDelivery: "2026-11-04",
      deliveredAt: undefined,
      service: "UPS 2nd Day Air",
      signatureRequired: true,
      premium: "ups_premier_gold",
      destinationState: "TX",
      destinationCountry: "US",
    });
    const [delivered] = upsPackages({ trackResponse: { shipment: [{ package: [upsDelivered(2)] }] } });
    expect(delivered).toMatchObject({ status: "delivered", deliveredAt: "2026-11-04", estimatedDelivery: undefined, carrierStatus: "KB" });
    const text = JSON.stringify(delivered);
    for (const kept of ["Test Receiver", "TEST RECEIVER", "Front Desk", "2 Example Avenue", "78701", "Austin", "c2lnbmF0dXJl", "cG9k", "TEST-REF", "Louisville"]) expect(text).not.toContain(kept);
  });

  it("prefers a rescheduled day over the scheduled one, in either order", () => {
    const days = (deliveryDate: unknown, type = "I") => upsPackages({ trackResponse: { shipment: [{ package: [{ trackingNumber: N[0], currentStatus: { type }, deliveryDate }] }] } })[0]!;
    expect(days([{ date: "20261104", type: "SDD" }, { date: "20261106", type: "RDD" }]).estimatedDelivery).toBe("2026-11-06");
    expect(days([{ date: "20261106", type: "RDD" }, { date: "20261104", type: "SDD" }]).estimatedDelivery).toBe("2026-11-06");
    expect(days([{ date: "20261104", type: "SDD" }, { date: "20261105", type: "SDD" }]).estimatedDelivery).toBe("2026-11-04");
    expect(days([{ date: "bad", type: "RDD" }, { date: "20261104", type: "SDD" }, null, "x"]).estimatedDelivery).toBe("2026-11-04");
    expect(days([{ date: "20261104", type: "DEL" }]).estimatedDelivery).toBeUndefined();
    expect(days([{ date: "20261104", type: "DEL" }]).deliveredAt).toBeUndefined();
    expect(days([{ date: "20261104", type: "DEL" }], "D").deliveredAt).toBe("2026-11-04");
    expect(days([{ date: "20261104", type: "SDD" }, { date: "20261106", type: "RDD" }], "D")).toMatchObject({ deliveredAt: undefined, estimatedDelivery: undefined });
    expect(days("20261104")).toMatchObject({ estimatedDelivery: undefined, deliveredAt: undefined });
  });

  it("picks the latest scan whatever order UPS lists them in, skipping ones that don't read", () => {
    const at = (activity: unknown) => upsPackages({ trackResponse: { shipment: [{ package: [{ trackingNumber: N[0], activity }] }] } })[0]!.lastEventAt;
    expect(at([{ gmtDate: "20261101", gmtTime: "233000" }, { gmtDate: "20261102", gmtTime: "124700" }, { gmtDate: "20261102", gmtTime: "x" }, null])).toBe("2026-11-02T12:47:00.000Z");
    expect(at([{ gmtDate: "20261102", gmtTime: "124700" }, { gmtDate: "20261101", gmtTime: "233000" }])).toBe("2026-11-02T12:47:00.000Z");
    expect(at([{ date: "20261102", time: "124700" }])).toBeUndefined();
    expect(at(undefined)).toBeUndefined();
  });

  it("reads only the destination's state and country, when they read", () => {
    const dest = (packageAddress: unknown) => {
      const p = upsPackages({ trackResponse: { shipment: [{ package: [{ trackingNumber: N[0], packageAddress }] }] } })[0]!;
      return [p.destinationState, p.destinationCountry];
    };
    expect(dest([{ type: "ORIGIN", address: { stateProvince: "NY", countryCode: "US" } }, { type: "DESTINATION", address: { stateProvince: " on ", countryCode: " ca " } }])).toEqual(["ON", "CA"]);
    expect(dest([{ type: "DESTINATION", address: { stateProvince: "Texas", countryCode: "USA" } }])).toEqual([undefined, undefined]);
    expect(dest([{ type: "DESTINATION", address: { stateProvince: "T", countryCode: "U" } }])).toEqual([undefined, undefined]);
    expect(dest([{ type: "DESTINATION", address: { stateProvince: 12, countryCode: null } }])).toEqual([undefined, undefined]);
    expect(dest([{ type: "DESTINATION" }, { type: "DESTINATION", address: { stateProvince: "TX", countryCode: "US" } }])).toEqual(["TX", "US"]);
    // Only the first destination with an address counts, even when nothing in it reads.
    expect(dest([{ type: "DESTINATION", address: { stateProvince: "Texas" } }, { type: "DESTINATION", address: { stateProvince: "TX", countryCode: "US" } }])).toEqual([undefined, undefined]);
    expect(dest([null, { type: "ORIGIN", address: { stateProvince: "NY" } }])).toEqual([undefined, undefined]);
  });

  it("reads signature and UPS Premier from the additional services", () => {
    const of = (additionalServices: unknown) => {
      const p = upsPackages({ trackResponse: { shipment: [{ package: [{ trackingNumber: N[0], additionalServices }] }] } })[0]!;
      return [p.signatureRequired, p.premium];
    };
    expect(of(["ADULT_SIGNATURE_REQUIRED", "UPS_PREMIER_PLATINUM"])).toEqual([true, "ups_premier_platinum"]);
    expect(of(["UPS_PREMIER_SILVER", "UPS_PREMIER_GOLD"])).toEqual([undefined, "ups_premier_silver"]);
    expect(of(["CARBON_NEUTRAL", 4, "toString"])).toEqual([undefined, undefined]);
    expect(of("SIGNATURE_REQUIRED")).toEqual([undefined, undefined]);
  });

  it("trims and cuts UPS's text, falling back to the long description, and keeps only short status codes", () => {
    const one = (currentStatus: unknown, service?: unknown) => upsPackages({ trackResponse: { shipment: [{ package: [{ trackingNumber: N[0], currentStatus, service }] }] } })[0]!;
    expect(one({ simplifiedTextDescription: "  On \n the   Way ", description: "x" }).description).toBe("On the Way");
    expect(one({ simplifiedTextDescription: "   ", description: "Arrived at Facility" }).description).toBe("Arrived at Facility");
    expect(one({ description: "d".repeat(300) }).description).toHaveLength(200);
    expect(one({ description: 5 }).description).toBeUndefined();
    expect(one({ code: "ab" }).carrierStatus).toBe("AB");
    expect(one({ code: "ABCD" }).carrierStatus).toBe("ABCD");
    expect(one({ code: "ABCDE" }).carrierStatus).toBeUndefined();
    expect(one({ code: "A-" }).carrierStatus).toBeUndefined();
    expect(one({ code: "" }).carrierStatus).toBeUndefined();
    expect(one({}, { description: "s".repeat(100) }).service).toHaveLength(80);
    expect(one({}, "UPS Ground").service).toBeUndefined();
    expect(one("D").status).toBe("unknown");
  });

  it("reads every package of every shipment, and skips ones without a usable number", () => {
    const body = {
      trackResponse: {
        shipment: [
          { package: [{ trackingNumber: " 1ztest01 0000000001 " }, { trackingNumber: "bad!" }, { trackingNumber: 7 }, null, "x"] },
          { package: [{ trackingNumber: N[1] }] },
          { package: "x" },
          null,
        ],
      },
    };
    expect(upsPackages(body).map((p) => p.trackingNumber)).toEqual([N[0], N[1]]);
    for (const empty of [null, {}, { trackResponse: [] }, { trackResponse: { shipment: {} } }]) expect(upsPackages(empty)).toEqual([]);
  });
});

describe("shipment tracking", () => {
  it("reads tracking numbers one or more a line, leaving out comments, repeats and anything else", () => {
    const text = `# exported ${"2026-11-10"}\n${N[0]}, ${N[1]};${N[0]}\r\n  # ${N[2]}\n\n1z test\t${N[3]!.toLowerCase()}\nnot-a-number ${N[4]}#x\n`;
    expect(parseTrackingNumbers(text, UPS_TRACKING_NUMBER)).toEqual([N[0], N[1], N[3]]);
    const many = Array.from({ length: MAX_TRACKING_NUMBERS + 1 }, (_, i) => upsTrackingNumber(i)).join("\n");
    expect(MAX_TRACKING_NUMBERS).toBe(5000);
    expect(() => parseTrackingNumbers(many, UPS_TRACKING_NUMBER)).toThrow("the tracking list has more than 5000 numbers; remove delivered ones");
    expect(parseTrackingNumbers(many.split("\n").slice(1).join("\n"), UPS_TRACKING_NUMBER)).toHaveLength(MAX_TRACKING_NUMBERS);
  });

  it("reads the list from its file each sync", async () => {
    const reads: string[] = [];
    const list = upsTrackingNumbersFromFile("/lists/ups.txt", async (p) => {
      reads.push(p);
      return `${N[0]}\n`;
    });
    expect(await list()).toEqual([N[0]]);
    expect(await list()).toEqual([N[0]]);
    expect(reads).toEqual(["/lists/ups.txt", "/lists/ups.txt"]);
    await expect(upsTrackingNumbersFromFile("/no/such/ups-list.txt")()).rejects.toThrow(/ENOENT/);
  });

  it("checks a checkpoint's shape, naming the carrier", () => {
    const good: TrackingCursor = { final: [N[0]!], firstSeen: { [N[1]!]: RECEIVED }, read: [N[1]!] };
    expect(parseTrackingCursor(JSON.stringify(good), UPS_TRACKING_NUMBER, "UPS")).toEqual(good);
    expect(parseTrackingCursor(null, UPS_TRACKING_NUMBER, "UPS")).toBeNull();
    for (const bad of [
      "not json",
      "null",
      "[]",
      "5",
      JSON.stringify({ firstSeen: {}, read: [] }),
      JSON.stringify({ final: "x", firstSeen: {}, read: [] }),
      JSON.stringify({ final: ["bad!"], firstSeen: {}, read: [] }),
      JSON.stringify({ final: [5], firstSeen: {}, read: [] }),
      JSON.stringify({ final: [12345678], firstSeen: {}, read: [] }),
      JSON.stringify({ final: [], firstSeen: {}, read: [12345678] }),
      JSON.stringify({ final: [], read: [] }),
      JSON.stringify({ final: [], firstSeen: null, read: [] }),
      JSON.stringify({ final: [], firstSeen: [], read: [] }),
      JSON.stringify({ final: [], firstSeen: { "bad!": RECEIVED }, read: [] }),
      JSON.stringify({ final: [], firstSeen: { [N[0]!]: "2026-11-10" }, read: [] }),
      JSON.stringify({ final: [], firstSeen: { [N[0]!]: "2026-02-30T00:00:00.000Z" }, read: [] }),
      JSON.stringify({ final: [], firstSeen: { [N[0]!]: `x${RECEIVED}` }, read: [] }),
      JSON.stringify({ final: [], firstSeen: { [N[0]!]: 5 }, read: [] }),
      JSON.stringify({ final: [], firstSeen: {} }),
      JSON.stringify({ final: [], firstSeen: {}, read: "x" }),
      JSON.stringify({ final: [], firstSeen: {}, read: ["bad!"] }),
      JSON.stringify({ final: [], firstSeen: {}, read: [5] }),
    ]) {
      expect(() => parseTrackingCursor(bad, UPS_TRACKING_NUMBER, "UPS")).toThrow("UPS checkpoint is not in the expected shape");
    }
    expect(parseTrackingCursor(JSON.stringify({ ...good, extra: 1 }), UPS_TRACKING_NUMBER, "UPS")).toEqual(good);
  });

  it("keys an event by its number and what was read, and times it by the latest scan or when it was read", () => {
    const base = { trackingNumber: N[0]!, status: "in_transit" as const, lastEventAt: "2026-11-02T12:47:00.000Z" };
    const a = shipmentEvent("ups", base, RECEIVED);
    expect(a).toEqual({
      id: expect.stringMatching(/^ups_[0-9a-f]{32}$/),
      type: "shipment.tracked",
      occurredAt: "2026-11-02T12:47:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^ups:${N[0]}:[0-9a-f]{16}$`)),
      payload: { shipmentId: `ups:package:${N[0]}`, carrier: "ups", trackingNumber: N[0], status: "in_transit", lastEventAt: "2026-11-02T12:47:00.000Z" },
    });
    expect(shipmentEvent("ups", base, "2026-12-01T00:00:00.000Z").idempotencyKey).toBe(a.idempotencyKey);
    expect(shipmentEvent("ups", base, "2026-12-01T00:00:00.000Z").id).toBe(a.id);
    expect(shipmentEvent("ups", { ...base, status: "delivered" }, RECEIVED).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(shipmentEvent("fedex", base, RECEIVED).id).toMatch(/^fedex_/);
    expect(shipmentEvent("ups", { trackingNumber: N[0]!, status: "label_created" }, RECEIVED).occurredAt).toBe(RECEIVED);
    expect(FINAL_STATUSES).toEqual(["delivered", "returned"]);
  });

  it("checks its limits", () => {
    const make = (o: object) => () => trackingConnector({ carrier: "ups", client: { track: async () => ({ kind: "not_found" }) }, pattern: UPS_TRACKING_NUMBER, trackingNumbers: async () => [], maxPerSync: 1, batchSize: 1, maxAgeDays: 1, writes: [], now: NOW, ...o });
    expect(make({})).not.toThrow();
    expect(make({ maxPerSync: 0 })).toThrow("maxPerSync must be a positive whole number");
    expect(make({ batchSize: 1.5 })).toThrow("batchSize must be a positive whole number");
    expect(make({ maxAgeDays: -1 })).toThrow("maxAgeDays must be a positive whole number");
  });
});

describe("UPS connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data());
  });

  it("reads at most 500 numbers a sync, 25 to a checkpoint, by default", async () => {
    const asked: string[] = [];
    const many = Array.from({ length: 501 }, (_, i) => upsTrackingNumber(100 + i));
    const c = upsConnector({ clientId: ID, clientSecret: SECRET, trackingNumbers: async () => many, now: NOW, client: { track: async (n) => (asked.push(n), { kind: "not_found" }) } });
    const batches = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(asked).toHaveLength(500);
    expect(batches).toHaveLength(20);
  });

  it("has nothing to write back", () => {
    expect(UPS_WRITES).toEqual([]);
    expect(connector().writes).toEqual([]);
    expect(connector().source).toBe("ups");
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 3 } });
    // Five numbers in batches of two.
    expect(result.full.batches).toBe(3);
    expect(result.replay.duplicates).toBe(3);
    const cursor = JSON.parse(result.full.cursor!) as TrackingCursor;
    expect(cursor).toEqual({ final: [N[1]], firstSeen: Object.fromEntries(N.map((n) => [n, RECEIVED])), read: [] });
  });

  it("records a package in transit, one delivered and an exception", async () => {
    const events = await eventsOf();
    expect(events.map((e) => [e.payload.trackingNumber, e.payload.status])).toEqual([
      [N[0], "in_transit"],
      [N[1], "delivered"],
      [N[2], "exception"],
    ]);
    expect(events[0]!.payload).toEqual({
      shipmentId: `ups:package:${N[0]}`,
      carrier: "ups",
      trackingNumber: N[0],
      status: "in_transit",
      carrierStatus: "IT",
      description: "On the Way",
      lastEventAt: "2026-11-02T12:47:00.000Z",
      estimatedDelivery: "2026-11-04",
      service: "UPS 2nd Day Air",
      signatureRequired: true,
      premium: "ups_premier_gold",
      destinationState: "TX",
      destinationCountry: "US",
    });
    expect(events[1]!.payload).toMatchObject({ status: "delivered", deliveredAt: "2026-11-04" });
    expect(events[2]!.payload).toMatchObject({ carrierStatus: "X1", description: "Delivery Exception" });
    expect(events[2]!.payload).not.toHaveProperty("signatureRequired");
    expect(events.every((e) => e.receivedAt === RECEIVED && e.occurredAt === "2026-11-02T12:47:00.000Z")).toBe(true);
  });

  it("stops reading a delivered or returned package, and reads the rest again each sync", async () => {
    const mock = upsDocMock(data({ packages: { ...data().packages, [N[4]!]: upsPackage.one({ trackingNumber: N[4], currentStatus: { type: "RS" } }) } }));
    const { memory, pipeline } = testPipeline();
    const c = connector(mock);
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 4 });
    mock.operations.length = 0;
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 2 });
    expect(mock.operations.filter((o) => o.startsWith("track:"))).toEqual([`track:${N[0]}`, `track:${N[2]}`, `track:${N[3]}`]);
  });

  it("keeps reading a number until every package under it is final", async () => {
    const both = [upsDelivered(1), upsPackage.one({ trackingNumber: upsTrackingNumber(9) })];
    const mock = upsDocMock(data({ packages: { [N[0]!]: both } }));
    const c = connector(mock, { trackingNumbers: async () => [N[0]!] });
    const first = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(first.flatMap((b) => b.events)).toHaveLength(2);
    expect((JSON.parse(lastCursor(first)!) as TrackingCursor).final).toEqual([]);
    const done = upsDocMock(data({ packages: { [N[0]!]: [upsDelivered(1), upsDelivered(9)] } }));
    const second = await collect(connector(done, { trackingNumbers: async () => [N[0]!] }).incrementalSync({ organizationId: TEST_ORG, cursor: lastCursor(first) }));
    expect((JSON.parse(lastCursor(second)!) as TrackingCursor).final).toEqual([N[0]]);
  });

  it("reads the oldest numbers first, up to the cap, and drops one that never moves after 120 days", async () => {
    const mock = upsDocMock(data());
    const cursor: TrackingCursor = {
      final: [],
      read: [],
      firstSeen: { [N[0]!]: "2026-07-13T12:00:00.000Z", [N[2]!]: "2026-11-01T00:00:00.000Z", [N[1]!]: "2026-07-12T12:00:00.000Z" },
    };
    const c = connector(mock, { maxPerSync: 3, trackingNumbers: async () => [...N].reverse() });
    const batches = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) }));
    // N[1] was first read 121 days ago; N[0] exactly 120. The cap stops one of the two new numbers.
    expect(mock.operations.filter((o) => o.startsWith("track:"))).toEqual([`track:${N[0]}`, `track:${N[2]}`, `track:${N[4]}`]);
    expect(batches).toHaveLength(2);
    const saved = JSON.parse(lastCursor(batches)!) as TrackingCursor;
    expect(Object.keys(saved.firstSeen)).toEqual([...N].sort());
    expect(saved.firstSeen[N[1]!]).toBe("2026-07-12T12:00:00.000Z");
  });

  it("forgets numbers taken off the list", async () => {
    const mock = upsDocMock(data());
    let list = [...N];
    const c = connector(mock, { trackingNumbers: async () => list });
    const first = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    list = [N[0]!];
    const second = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: lastCursor(first) }));
    expect(JSON.parse(lastCursor(second)!)).toEqual({ final: [], firstSeen: { [N[0]!]: RECEIVED }, read: [] });
    list = [N[1]!];
    mock.operations.length = 0;
    await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: lastCursor(second) }));
    // Delivered before, but forgotten when it left the list, so it is read again.
    expect(mock.operations).toEqual([`track:${N[1]}`]);
  });

  it("checkpoints once with nothing to read", async () => {
    const mock = upsDocMock(data());
    const empty = await collect(connector(mock, { trackingNumbers: async () => [] }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(empty).toEqual([{ events: [], cursor: JSON.stringify({ final: [], firstSeen: {}, read: [] }) }]);
    const allDone = await collect(connector(mock, { trackingNumbers: async () => [N[1]!] }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ final: [N[1]], firstSeen: { [N[1]!]: RECEIVED }, read: [] }) }));
    expect(allDone).toEqual([{ events: [], cursor: JSON.stringify({ final: [N[1]], firstSeen: { [N[1]!]: RECEIVED }, read: [] }) }]);
    expect(mock.operations).toEqual([]);
  });

  it("turns down a checkpoint it can't read before calling UPS", async () => {
    const mock = upsDocMock(data());
    await expect(collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: "{}" }))).rejects.toThrow("ups checkpoint is not in the expected shape");
    expect(mock.operations).toEqual([]);
  });

  it("skips numbers already read when it resumes partway, and reads them all on the next sync", async () => {
    const mock = upsDocMock(data());
    const c = connector(mock);
    const batches = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const middle = JSON.parse(batches[0]!.cursor!) as TrackingCursor;
    expect(middle.read).toEqual([N[0], N[1]]);
    expect(JSON.parse(batches[1]!.cursor!).read).toEqual([N[0], N[1], N[2], N[3]]);
    mock.operations.length = 0;
    const resumed = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: batches[0]!.cursor }));
    expect(mock.operations.filter((o) => o.startsWith("track:"))).toEqual([`track:${N[2]}`, `track:${N[3]}`, `track:${N[4]}`]);
    expect(JSON.parse(lastCursor(resumed)!).read).toEqual([]);
    mock.operations.length = 0;
    await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: lastCursor(resumed) }));
    expect(mock.operations.filter((o) => o.startsWith("track:"))).toEqual([`track:${N[0]}`, `track:${N[2]}`, `track:${N[3]}`, `track:${N[4]}`]);
    // A checkpoint left with every remaining number read starts over too.
    mock.operations.length = 0;
    const stuck = JSON.stringify({ final: [N[1]], firstSeen: Object.fromEntries(N.map((n) => [n, RECEIVED])), read: [N[0], N[2], N[3], N[4]] });
    expect(await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: stuck }))).toEqual([{ events: [], cursor: JSON.stringify({ final: [N[1]], firstSeen: Object.fromEntries(N.map((n) => [n, RECEIVED])), read: [] }) }]);
    // Numbers read but since taken off the list are dropped from it.
    const off = await collect(connector(mock, { batchSize: 1, trackingNumbers: async () => [N[0]!, N[2]!, N[3]!] }).incrementalSync({ organizationId: TEST_ORG, cursor: batches[0]!.cursor }));
    expect(JSON.parse(off[0]!.cursor!).read).toEqual([N[0], N[2]]);
  });

  it("clears what it read when the last batch is exactly full, and saves its lists sorted", async () => {
    const mock = upsDocMock(data({ packages: { ...data().packages, [N[4]!]: upsDelivered(5) } }));
    const batches = await collect(connector(mock, { trackingNumbers: async () => [N[4]!, N[1]!, N[0]!, N[2]!] }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(batches).toHaveLength(2);
    expect(JSON.parse(batches[0]!.cursor!)).toMatchObject({ final: [N[1], N[4]], read: [N[1], N[4]] });
    expect(JSON.parse(batches[1]!.cursor!)).toMatchObject({ final: [N[1], N[4]], read: [] });
  });
});
