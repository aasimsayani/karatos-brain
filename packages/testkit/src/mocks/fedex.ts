import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * FedEx's OAuth and Track APIs. FedEx keeps its request and response
 * schemas inside a page that needs JavaScript and isn't open to this
 * project's fetches, so the mock is built from FedEx's public catalog page
 * and announcements and from the public sample responses FedEx's own
 * mock-ready examples give. Data is synthetic. FedEx's sandbox
 * (apis-sandbox.fedex.com) replaces this mock once a test project is set up.
 *
 * Docs facts the mock relies on:
 * - Tracking is POST /track/v1/trackingnumbers with a bearer token, the
 *   x-customer-transaction-id and x-locale headers, and a body of
 *   includeDetailedScans and trackingInfo[] of trackingNumberInfo
 *   {trackingNumber}, up to 30 numbers (developer.fedex.com catalog, track).
 * - It answers transactionId, customerTransactionId and
 *   output.completeTrackResults[] of {trackingNumber, trackResults[]}; a
 *   track result has trackingNumberInfo, latestStatusDetail {code,
 *   derivedCode, statusByLocale, description, scanLocation}, dateAndTimes[]
 *   {type, dateTime}, scanEvents[], serviceDetail {type, description},
 *   recipientInformation, deliveryDetails {receivedByName, ...},
 *   estimatedDeliveryTimeWindow {window {begins, ends}} and, for a problem
 *   with one number, error {code, message}. Errors for the whole call are
 *   errors[] of {code, message}.
 * - 100,000 calls a day (developer.fedex.com catalog, track).
 */
const CATALOG = "https://developer.fedex.com/api/en-us/catalog/track.html";
const BASE = "https://apis.fedex.com";

export type FedexMockResult = Record<string, unknown>;

export interface FedexMockData {
  clientId: string;
  clientSecret: string;
  /** Track results by tracking number. A number not here answers a result with a not-found error. */
  results: Record<string, FedexMockResult | FedexMockResult[]>;
  throttle?: number;
  outage?: number;
  /** Seconds the token lasts. Defaults to 3599. */
  expiresIn?: number;
  revoked?: Set<string>;
}

/** A synthetic 12-digit FedEx number. */
export const fedexTrackingNumber = (n: number) => `99${String(n).padStart(10, "0")}`;

export const fedexResult = fixtureBuilder<FedexMockResult>((n) => ({
  trackingNumberInfo: { trackingNumber: fedexTrackingNumber(n), trackingNumberUniqueId: `uid-${n}`, carrierCode: "FDXE" },
  additionalTrackingInfo: { nickname: "", hasAssociatedShipments: false },
  shipperInformation: { contact: { personName: "Test Shipper" }, address: { city: "NEW YORK", stateOrProvinceCode: "NY", countryCode: "US", residential: false } },
  recipientInformation: { contact: { personName: "Test Receiver" }, address: { streetLines: ["2 Example Avenue"], city: "AUSTIN", stateOrProvinceCode: "TX", postalCode: "78701", countryCode: "US", residential: false } },
  latestStatusDetail: { code: "IT", derivedCode: "IT", statusByLocale: "In transit", description: "In transit", scanLocation: { city: "MEMPHIS", stateOrProvinceCode: "TN", countryCode: "US" } },
  dateAndTimes: [
    { type: "ESTIMATED_DELIVERY", dateTime: "2026-11-04T10:30:00-06:00" },
    { type: "ACTUAL_PICKUP", dateTime: "2026-11-01T17:10:00-05:00" },
    { type: "SHIP", dateTime: "2026-11-01T00:00:00-05:00" },
  ],
  scanEvents: [
    { date: "2026-11-02T06:47:00-06:00", eventType: "AR", eventDescription: "At local FedEx facility", derivedStatusCode: "IT", derivedStatus: "In transit", scanLocation: { streetLines: [""], city: "MEMPHIS", stateOrProvinceCode: "TN", postalCode: "38118", countryCode: "US" } },
    { date: "2026-11-01T17:10:00-05:00", eventType: "PU", eventDescription: "Picked up", derivedStatusCode: "PU", derivedStatus: "Picked up", scanLocation: { city: "NEW YORK", stateOrProvinceCode: "NY", countryCode: "US" } },
  ],
  serviceDetail: { type: "FEDEX_2_DAY", description: "FedEx 2Day", shortDescription: "2D" },
  specialHandlings: [{ type: "DIRECT_SIGNATURE_REQUIRED", description: "Direct signature required", paymentType: "OTHER" }],
  packageDetails: { count: "1", weightAndDimensions: { weight: [{ value: "1.0", unit: "LB" }] }, declaredValue: { currency: "USD", value: 2500 } },
  estimatedDeliveryTimeWindow: { window: {} },
}));

/** A delivered result, with what FedEx sends about who received it. */
export const fedexDelivered = (n: number, over: FedexMockResult = {}): FedexMockResult =>
  fedexResult.one({
    trackingNumberInfo: { trackingNumber: fedexTrackingNumber(n) },
    latestStatusDetail: { code: "DL", derivedCode: "DL", statusByLocale: "Delivered", description: "Delivered" },
    dateAndTimes: [{ type: "ACTUAL_DELIVERY", dateTime: "2026-11-04T10:12:00-06:00" }],
    deliveryDetails: { receivedByName: "T.RECEIVER", signedByName: "T.RECEIVER", locationDescription: "Front desk" },
    availableImages: [{ type: "SIGNATURE_PROOF_OF_DELIVERY" }],
    ...over,
  });

const errors = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { transactionId: "test-transaction", errors: [{ code, message }] } });

export interface FedexMock {
  api: DocMock;
  fetch: DocMockFetch;
  readonly operations: string[];
  readonly transactionIds: string[];
  readonly tokens: string[];
}

export function fedexDocMock(data: FedexMockData): FedexMock {
  const operations: string[] = [];
  const transactionIds: string[] = [];
  const tokens: string[] = [];
  let throttle = data.throttle ?? 0;
  let outage = data.outage ?? 0;

  const api = checkDocMock({
    integration: "fedex",
    baseUrl: BASE,
    source: { url: CATALOG, title: "FedEx Track API catalog page", retrievedOn: "2026-11-10", version: "Track API v1" },
    assumptions: [
      "The token is POST /oauth/token with the form grant_type=client_credentials, client_id and client_secret, answering access_token, token_type, expires_in (a number of seconds) and scope",
      "A bad API key or secret is 401 with errors[] code NOT.AUTHORIZED.ERROR",
      "A number FedEx has nothing for comes back in a 200 as a track result with error code TRACKING.TRACKINGNUMBER.NOTFOUND",
      "latestStatusDetail codes are OC and IN label created, PU picked up, IT, AR, DP and AF in transit, OD out for delivery, DL delivered, DE, SE, CA and DY exception, RS returned",
      "specialHandlings names a signature as DIRECT_SIGNATURE_REQUIRED, ADULT_SIGNATURE_REQUIRED or INDIRECT_SIGNATURE_REQUIRED",
      "dateTime values carry the local UTC offset, such as 2026-11-04T10:30:00-06:00",
    ],
    routes: [
      {
        method: "POST",
        path: "/oauth/token",
        documentedAt: CATALOG,
        respond(request) {
          operations.push("token");
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return errors(400, "BAD.REQUEST.ERROR", "Invalid content type");
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "client_credentials") return errors(400, "BAD.REQUEST.ERROR", "Invalid grant_type");
          if (form.get("client_id") !== data.clientId || form.get("client_secret") !== data.clientSecret) return errors(401, "NOT.AUTHORIZED.ERROR", "The given client credentials were not valid.");
          const token = `testtoken${String(tokens.length + 1).padStart(12, "0")}`;
          tokens.push(token);
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: data.expiresIn ?? 3599, scope: "CXS" } };
        },
      },
      {
        method: "POST",
        path: "/track/v1/trackingnumbers",
        documentedAt: CATALOG,
        respond(request) {
          if (throttle > 0) {
            throttle--;
            return { ...errors(429, "RATE.LIMIT.EXCEEDED", "Too many requests"), headers: { "retry-after": "2" } };
          }
          if (outage > 0) {
            outage--;
            return errors(503, "SERVICE.UNAVAILABLE.ERROR", "The service is currently unavailable");
          }
          const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
          if (!bearer || !tokens.includes(bearer) || data.revoked?.has(bearer)) return errors(401, "NOT.AUTHORIZED.ERROR", "Access token expired. Please modify your request and try again.");
          const transactionId = request.headers.get("x-customer-transaction-id") ?? "";
          if (!transactionId) return errors(400, "BAD.REQUEST.ERROR", "Missing x-customer-transaction-id");
          transactionIds.push(transactionId);
          let body: { includeDetailedScans?: unknown; trackingInfo?: { trackingNumberInfo?: { trackingNumber?: unknown } }[] };
          try {
            body = JSON.parse(request.body) as typeof body;
          } catch {
            return errors(400, "BAD.REQUEST.ERROR", "Invalid JSON");
          }
          const numbers = (body.trackingInfo ?? []).map((t) => String(t.trackingNumberInfo?.trackingNumber ?? ""));
          if (numbers.length === 0 || numbers.length > 30) return errors(400, "TRACKING.TRACKINGNUMBER.EMPTY", "Please provide tracking number.");
          operations.push(`track:${numbers.join(",")}`);
          const completeTrackResults = numbers.map((n) => {
            const found = data.results[n];
            const trackResults = found ? (Array.isArray(found) ? found : [found]) : [{ trackingNumberInfo: { trackingNumber: n }, error: { code: "TRACKING.TRACKINGNUMBER.NOTFOUND", message: "Tracking number cannot be found. Please correct the tracking number and try again." } }];
            return { trackingNumber: n, trackResults };
          });
          return { status: 200, body: { transactionId: "test-transaction", customerTransactionId: transactionId, output: { completeTrackResults } } };
        },
      },
    ],
  });

  return {
    api,
    fetch: docMockFetch(api),
    get operations() {
      return operations;
    },
    get transactionIds() {
      return transactionIds;
    },
    get tokens() {
      return tokens;
    },
  };
}

export default {
  integration: "fedex",
  covers: "FedEx's OAuth client credentials token and Track API tracking-number call",
  watchPages: [CATALOG, "https://developer.fedex.com/api/en-us/announcements.html"],
  docMocks: () => [fedexDocMock({ clientId: "", clientSecret: "", results: {} }).api],
} satisfies DocMockModule;
