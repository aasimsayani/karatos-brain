import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * UPS's OAuth and Tracking APIs, built from the OpenAPI files UPS publishes
 * (github.com/UPS-API/api-documentation, OAuthClientCredentials.yaml and
 * Tracking.yaml). Data is synthetic. UPS's Customer Integration Environment
 * (wwwcie.ups.com) replaces this mock once a test app is set up.
 *
 * Docs facts the mock relies on:
 * - The token is a POST to /security/v1/oauth/token with Basic auth of the
 *   client id and secret and the form grant_type=client_credentials. It
 *   answers token_type, issued_at, client_id, access_token, expires_in (a
 *   string of seconds), refresh_count and status; a bad client is 401 with
 *   {response: {errors: [{code, message}]}} (OAuthClientCredentials.yaml).
 * - Tracking is GET /api/track/v1/details/{inquiryNumber} (7 to 34
 *   characters) with a bearer token and the transId and transactionSrc
 *   headers, and the locale, returnSignature, returnMilestones and returnPOD
 *   query (Tracking.yaml).
 * - It answers 200 with trackResponse.shipment[], each with inquiryNumber,
 *   package[] and warnings[]; 404 when the number isn't found; 400, 403, 500
 *   and 503 with the same errors shape (Tracking.yaml).
 * - A package has trackingNumber, currentStatus {code, description,
 *   simplifiedTextDescription, statusCode, type}, activity[] {date, time,
 *   gmtDate, gmtTime, gmtOffset, location, status}, deliveryDate[] {date,
 *   type}, deliveryTime, packageAddress[] {type, name, attentionName,
 *   address}, additionalServices[], service {code, description, levelCode},
 *   packageCount, weight and deliveryInformation {receivedBy, location,
 *   signature, pod} (Tracking.yaml).
 */
const SPEC = "https://github.com/UPS-API/api-documentation/blob/main";
const BASE = "https://onlinetools.ups.com";

export type UpsMockPackage = Record<string, unknown>;

export interface UpsMockData {
  clientId: string;
  clientSecret: string;
  /** Packages by tracking number. A number not here answers 404. */
  packages: Record<string, UpsMockPackage | UpsMockPackage[]>;
  /** Numbers UPS answers with only a warning, as it does for some it can't read yet. */
  warnings?: string[];
  /** The next this many tracking requests answer 429. */
  throttle?: number;
  /** The next this many tracking requests answer 503. */
  outage?: number;
  /** Seconds the token lasts, as UPS writes it. Defaults to "14399". */
  expiresIn?: string;
  /** Tokens the mock no longer takes, as when UPS revokes one early. */
  revoked?: Set<string>;
}

/** A synthetic 1Z number with a correct-looking shape: 1Z, a six-character account, a service code and an eight-digit package number. */
export const upsTrackingNumber = (n: number) => `1ZTEST01${String(n).padStart(10, "0")}`;

export const upsPackage = fixtureBuilder<UpsMockPackage>((n) => ({
  trackingNumber: upsTrackingNumber(n),
  currentStatus: { code: "IT", description: "On the Way", simplifiedTextDescription: "On the Way", statusCode: "005", type: "I" },
  activity: [
    { date: "20261102", time: "074700", gmtDate: "20261102", gmtTime: "124700", gmtOffset: "-05:00", location: { address: { city: "Louisville", stateProvince: "KY", countryCode: "US", country: "US" } }, status: { code: "AR", description: "Arrived at Facility", simplifiedTextDescription: "On the Way", statusCode: "005", type: "I" } },
    { date: "20261101", time: "183000", gmtDate: "20261101", gmtTime: "233000", gmtOffset: "-05:00", location: { address: { city: "New York", stateProvince: "NY", countryCode: "US", country: "US" } }, status: { code: "OR", description: "Origin Scan", simplifiedTextDescription: "On the Way", statusCode: "005", type: "I" } },
  ],
  deliveryDate: [{ date: "20261104", type: "SDD" }],
  deliveryTime: { type: "EOD", startTime: "", endTime: "230000" },
  packageAddress: [
    { type: "ORIGIN", name: "Test Shipper", attentionName: "Shipping Desk", address: { addressLine1: "1 Test Street", city: "New York", stateProvince: "NY", postalCode: "10036", countryCode: "US", country: "US" } },
    { type: "DESTINATION", name: "Test Receiver", attentionName: "Front Desk", address: { addressLine1: "2 Example Avenue", city: "Austin", stateProvince: "TX", postalCode: "78701", countryCode: "US", country: "US" } },
  ],
  additionalServices: ["SIGNATURE_REQUIRED", "UPS_PREMIER_GOLD"],
  service: { code: "002", description: "UPS 2nd Day Air", levelCode: "02" },
  packageCount: 1,
  weight: { unitOfMeasurement: "LBS", weight: "1.00" },
  referenceNumber: [{ type: "SHIPMENT", number: "TEST-REF" }],
}));

/** A delivered package, with what UPS sends about who signed. */
export const upsDelivered = (n: number, over: UpsMockPackage = {}): UpsMockPackage =>
  upsPackage.one({
    trackingNumber: upsTrackingNumber(n),
    currentStatus: { code: "KB", description: "Delivered", simplifiedTextDescription: "Delivered", statusCode: "011", type: "D" },
    deliveryDate: [{ date: "20261104", type: "DEL" }],
    deliveryInformation: { receivedBy: "TEST RECEIVER", location: "Front Desk", signature: { image: "c2lnbmF0dXJl" }, pod: { content: "cG9k" } },
    ...over,
  });

const errors = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { response: { errors: [{ code, message }] } } });

export interface UpsMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Every request answered, in order: token, or track:<number>. */
  readonly operations: string[];
  /** The transId of every tracking request, in order. */
  readonly transIds: string[];
  /** Tokens handed out, in order. */
  readonly tokens: string[];
}

export function upsDocMock(data: UpsMockData): UpsMock {
  const operations: string[] = [];
  const transIds: string[] = [];
  const tokens: string[] = [];
  let throttle = data.throttle ?? 0;
  let outage = data.outage ?? 0;

  const api = checkDocMock({
    integration: "ups",
    baseUrl: BASE,
    source: { url: `${SPEC}/Tracking.yaml`, title: "UPS Tracking API OpenAPI file", retrievedOn: "2026-11-10", version: "Track API v1, OAuth client credentials v1" },
    assumptions: [
      "currentStatus.type is D delivered, I in transit, M label created, MV label voided, P picked up, X exception, RS returned and O out for delivery (the file gives X as its only example)",
      "Out for delivery comes back as type I with that text in simplifiedTextDescription",
      "packageAddress type is ORIGIN or DESTINATION",
      "additionalServices names UPS Premier as UPS_PREMIER_SILVER, UPS_PREMIER_GOLD or UPS_PREMIER_PLATINUM",
      "A number UPS can't read yet comes back as a 200 with warnings and no package",
    ],
    routes: [
      {
        method: "POST",
        path: "/security/v1/oauth/token",
        documentedAt: `${SPEC}/OAuthClientCredentials.yaml`,
        respond(request) {
          operations.push("token");
          const expected = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
          if (request.headers.get("authorization") !== expected) return errors(401, "10401", "ClientId is Invalid");
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return errors(400, "10400", "Invalid/Missing Content-Type");
          if (new URLSearchParams(request.body).get("grant_type") !== "client_credentials") return errors(400, "10400", "Invalid/Missing grant_type");
          const token = `testtoken${String(tokens.length + 1).padStart(12, "0")}`;
          tokens.push(token);
          return { status: 200, body: { token_type: "Bearer", issued_at: "1762790400000", client_id: data.clientId, access_token: token, scope: "", expires_in: data.expiresIn ?? "14399", refresh_count: "0", status: "approved" } };
        },
      },
      {
        method: "GET",
        path: "/api/track/v1/details/{inquiryNumber}",
        documentedAt: `${SPEC}/Tracking.yaml`,
        respond(request, params) {
          const number = params.inquiryNumber ?? "";
          operations.push(`track:${number}`);
          if (throttle > 0) {
            throttle--;
            return { ...errors(429, "10429", "Too Many Requests"), headers: { "retry-after": "2" } };
          }
          if (outage > 0) {
            outage--;
            return errors(503, "10503", "Resource is not available");
          }
          const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
          if (!bearer || !tokens.includes(bearer) || data.revoked?.has(bearer)) return errors(401, "250002", "Invalid Authentication Information.");
          const transId = request.headers.get("transid") ?? "";
          if (!/^\S{1,32}$/.test(transId) || !request.headers.get("transactionsrc")) return errors(400, "TV0001", "Missing transId or transactionSrc");
          transIds.push(transId);
          if (!/^[A-Za-z0-9]{7,34}$/.test(number)) return errors(400, "TV0002", "Invalid inquiry number");
          const q = request.url.searchParams;
          if (q.get("returnSignature") === "true" || q.get("returnPOD") === "true") throw new Error("the UPS mock was asked for a signature or proof of delivery; the connector never asks");
          if (data.warnings?.includes(number)) return { status: 200, body: { trackResponse: { shipment: [{ inquiryNumber: number, package: [], warnings: [{ code: "TW0001", message: "Tracking Information Not Found" }] }] } } };
          const found = data.packages[number];
          if (!found) return errors(404, "TW0001", "Tracking Information Not Found");
          return { status: 200, body: { trackResponse: { shipment: [{ inquiryNumber: number, package: Array.isArray(found) ? found : [found], userRelation: [] }] } } };
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
    get transIds() {
      return transIds;
    },
    get tokens() {
      return tokens;
    },
  };
}

export default {
  integration: "ups",
  covers: "UPS's OAuth client credentials token and Tracking API details call",
  watchPages: [`${SPEC}/Tracking.yaml`, `${SPEC}/OAuthClientCredentials.yaml`],
  docMocks: () => [upsDocMock({ clientId: "", clientSecret: "", packages: {} }).api],
} satisfies DocMockModule;
