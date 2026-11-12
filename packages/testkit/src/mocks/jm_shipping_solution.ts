import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The five reads of the JM Shipping Solution API (v1) a read-only connector
 * uses, built from Jewelers Mutual's developer docs. Data is synthetic. JM
 * issues credentials per integrator; once a store's key and password are
 * set up, recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - The APIs take a key and password JM issues each integrator, with basic
 *   authentication, and must be called from a backend (authentication).
 * - Every endpoint needs two headers: `Authorization` (basic credentials)
 *   and `API_KEY` (a GUID in the examples). The only host shown is
 *   https://uat2.transguardian.com. A bad or missing parameter, and bad
 *   credentials, answer 400 (each endpoint page).
 * - `GET /api/v1/shipment/list/{clientId}/{startDate}/{endDate}` answers
 *   {Error: [{ErrorCode, ErrorMessage}], ShipmentGids: [string]}; its
 *   example has an error saying the start date must come before the end
 *   date (shipments/getbyclientidstartdateenddate).
 * - `GET /api/v1/shipment/{ids}` takes a comma-delimited list of shipment
 *   ids or GUIDs and answers a list of ShipmentReturn {Shipment,
 *   ShipmentStatus (0 SAVED, 1 CREATED), Status (0 FAILURE, 1 SUCCESS,
 *   2 WARNING, 3 NOTE), StatusMessages, Error, Rates, Purchase,
 *   ForbiddenWords, IsPending}. A Shipment has Id, Gid, ClientId, FromAddress
 *   and ToAddress (with Zip and CountryCode), Carriers and Services (lists
 *   of enums), DeclaredValue, InvoiceValue, WeightOzDecimal, ShipDate,
 *   CarrierDeliveryDate, TransactionTime, VoidedOn, VoidId, TrackingNumber,
 *   TrackingStatus, Reference1 to Reference5, IsReturnShipment, IsReconciled
 *   and more; enums are JSON numbers (shipments/getbyids).
 * - `GET /api/v1/shipment/track/{fullHistory}/{ids}` takes full or latest
 *   and answers a list of {Activities: [{activityDescription,
 *   carrierActivityCode, tgActivityCode, activityCity, activityState,
 *   activityZip, activityCountry, activityDate, activityTime,
 *   activityDateTime}], TrackingNumber, Id, Gid, ZingId, Error, Status}
 *   (tracking/trackbyidsfullhistory).
 * - `GET /api/v1/claim/{id}` takes a shipment GUID or confirmation number
 *   and answers {Claim, Error}; a shipment with no claim yet gets a claim
 *   with a zero id, and a claim not found answers 404. A Claim has Id,
 *   Status (2 NO_CLAIM to 16 ARCHIVED), CurrentStatus, LossType,
 *   ReasonForClaim, eCargo, ClaimValue, InsuredValue, ClaimFiledOn,
 *   ClaimDueDate and more (claims/getbyid).
 * - `GET /api/v1/shipment/reconciliation/{clientId}/{startDate}/{endDate}`
 *   answers a list of ReconciledShipment {ShipmentId, ShipmentGid,
 *   PurchasedOn, ReconciledOn, TrackingNumber, Reference, FromCompany,
 *   ToCompany, ToContact, Cargo, Carrier, Service, AdjustmentAmount,
 *   Comment, ReviewComment, OriginalFreightPrice, FreightPrice,
 *   InvoiceReference, ClientId} (reconciliation/reconciledshipmentsbyclientidstartdateenddate).
 */
const BASE = "https://uat2.transguardian.com";
const DOCS = "https://docs.jewelersmutual.com/jm-shipping-solution";
const REF = `${DOCS}/api-reference/jm-shipping-solution`;
export const JM_SHIPPING_DOC_PAGES = {
  overview: `${DOCS}/overview`,
  shipmentList: `${REF}/shipments/getbyclientidstartdateenddate.md`,
  shipments: `${REF}/shipments/getbyids.md`,
  tracking: `${REF}/tracking/trackbyidsfullhistory.md`,
  claim: `${REF}/claims/getbyid.md`,
  reconciliation: `${REF}/reconciliation/reconciledshipmentsbyclientidstartdateenddate.md`,
} as const;
const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type JmShippingMockRecord = Record<string, unknown>;

const pad = (n: number, width: number) => String(n).padStart(width, "0");
/** Shipment `n`'s GUID: aaaaaaaa-bbbb-4ccc-8ddd-e followed by n in 11 digits. */
export const jmShippingGidOf = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-e${pad(n, 11)}`;
/** Shipment `n`'s tracking number. */
export const jmShippingTrackingOf = (n: number) => `JMTEST${pad(n, 6)}`;
/** When shipment `n` was bought: shipment 1 on October 1, 2026 at 15:00 UTC, and each next one six hours later. */
export const jmShippingBoughtAt = (n: number) => new Date(Date.parse("2026-10-01T15:00:00Z") + (n - 1) * 6 * 3_600_000).toISOString();
const bought = jmShippingBoughtAt;

const address = (n: number, state: string, zip: string) => ({
  Id: `addr-${n}`,
  AddressType: 2,
  Company: `Test Company ${n}`,
  Contact: synthetic.name(n),
  AddressLine1: `${n} Test Street`,
  AddressLine2: "Suite 100",
  City: "Test City",
  State: state,
  Zip: zip,
  CountryCode: "US",
  PhoneNumber: synthetic.phone(n),
  EmailAddress: synthetic.email(n),
  Residential: true,
});

/**
 * Shipment `n` as a ShipmentReturn: bought (CREATED) at jmShippingBoughtAt(n)
 * by UPS two-day AM, declared at $2,500 against a $3,000 invoice,
 * enroute, with one rate and every address detail the connector must drop.
 */
export const jmShippingShipment = fixtureBuilder<JmShippingMockRecord>((n) => ({
  Shipment: {
    Id: 70000 + n,
    Gid: jmShippingGidOf(n),
    ZingId: `zing-${n}`,
    JMTraceID: `trace-${n}`,
    ClientId: 4321,
    FromAddress: address(1000 + n, "NY", "10001"),
    ToAddress: address(n, "ca", "90001"),
    Package: { Type: 2, PackageDimX: 6, PackageDimY: 4, PackageDimZ: 2 },
    WeightOzDecimal: 8.5,
    Carriers: [7],
    Services: [4],
    Signatures: [1],
    DeclaredValue: 2500,
    InvoiceValue: 3000,
    ShipDate: bought(n),
    CarrierShipDate: bought(n),
    CarrierDeliveryDate: new Date(Date.parse(bought(n)) + 2 * 86_400_000).toISOString(),
    DeliveryDate: "2 days",
    TransactionTime: bought(n),
    VoidedOn: null,
    VoidId: 0,
    TrackingNumber: jmShippingTrackingOf(n),
    TrackingStatus: 80,
    Reference1: `ORD-${n}`,
    Reference2: `Gift for ${synthetic.name(n)}`,
    IsReturnShipment: false,
    IsHoldForPickup: false,
    IsReconciled: false,
    ApprovalRequired: false,
    InternationalDetail: null,
  },
  ShipmentStatus: 1,
  Status: 1,
  StatusMessages: [],
  Error: [],
  Rates: [{ Price: 42.5, InsurancePrice: 12.5, FreightPrice: 30, Carrier: 7, Service: 4, Signature: 1, AccountNumber: "TEST-ACCOUNT", TotalAdminFees: 0 }],
  Purchase: { Id: 80000 + n, Gid: jmShippingGidOf(n), TrackingNumber: jmShippingTrackingOf(n), Labels: ["https://example.test/label.pdf"], InternationalFormsUrl: null },
  ForbiddenWords: [],
  IsPending: false,
}));

/** Shipment `n`'s tracking: a scan an hour after it was bought (enroute), then one a day later (out for delivery). */
export const jmShippingTracking = fixtureBuilder<JmShippingMockRecord>((n) => {
  const at = (hours: number) => new Date(Date.parse(bought(n)) + hours * 3_600_000).toISOString();
  const activity = (hours: number, code: number, description: string, carrier: string) => ({
    activityDescription: description,
    carrierActivityCode: carrier,
    tgActivityCode: code,
    activityCity: "Test City",
    activityState: "CA",
    activityZip: "90001",
    activityCountry: "US",
    activityDate: at(hours).slice(0, 10),
    activityTime: at(hours).slice(11, 19),
    activityDateTime: at(hours),
  });
  return {
    Activities: [activity(1, 80, "Departed facility", "DP"), activity(25, 89, "Out for delivery", "OT")],
    TrackingNumber: jmShippingTrackingOf(n),
    Id: 70000 + n,
    Gid: jmShippingGidOf(n),
    ZingId: `zing-${n}`,
    Error: null,
    Status: 1,
  };
});

/** A claim on shipment `n`: filed five days after it was bought, contents stolen, $2,500 claimed, with the details the connector must drop. */
export const jmShippingClaim = fixtureBuilder<JmShippingMockRecord>((n) => ({
  Id: 90000 + n,
  ClientId: 4321,
  ShipmentId: 70000 + n,
  ShipmentGid: jmShippingGidOf(n),
  TrackingNumber: jmShippingTrackingOf(n),
  FromAddress: address(1000 + n, "NY", "10001"),
  ToAddress: address(n, "CA", "90001"),
  ClaimantAddress: address(2000 + n, "NY", "10001"),
  ShipDate: bought(n),
  ClaimFiledOn: new Date(Date.parse(bought(n)) + 5 * 86_400_000).toISOString(),
  ClaimDueDate: new Date(Date.parse(bought(n)) + 60 * 86_400_000).toISOString(),
  LossType: 1,
  PackageContents: "A test ring",
  RolexOrGIAProduct: 2,
  PoliceReportNumber: "TEST-REPORT-1",
  ReasonForClaim: 4,
  InsuredValue: 2500,
  CustomsValue: 0,
  InvoiceValue: 3000,
  PackageCount: 1,
  WeightOz: 8.5,
  PostagePurchased: true,
  Status: 4,
  CurrentStatus: "SUBMITTED",
  eCargo: 7,
  NextSteps: "Test next steps",
  UpdateNotes: "Test notes",
  CarrierClaimNumber: "",
  CarrierDeclaredValue: 100,
  CarrierLiability: 0,
  ClaimValue: 2500,
  ReplacementValue: 2800,
  DamageDescription: "Test damage",
  Comment: "Test comment",
}));

/** Shipment `n` reconciled a week after it was bought, $3 over the $30 freight first quoted. */
export const jmShippingReconciled = fixtureBuilder<JmShippingMockRecord>((n) => ({
  ShipmentId: 70000 + n,
  ShipmentGid: jmShippingGidOf(n),
  PurchasedOn: bought(n),
  ReconciledOn: new Date(Date.parse(bought(n)) + 7 * 86_400_000).toISOString(),
  TrackingNumber: jmShippingTrackingOf(n),
  Reference: `Order for ${synthetic.name(n)}`,
  FromCompany: "Test Jeweler",
  ToCompany: `Test Company ${n}`,
  ToContact: synthetic.name(n),
  Cargo: 7,
  Carrier: 7,
  Service: 4,
  AdjustmentAmount: 3,
  Comment: "Test comment",
  ReviewComment: "Test review",
  OriginalFreightPrice: 30,
  FreightPrice: 33,
  InvoiceReference: `INV-TEST-${n}`,
  ClientId: 4321,
}));

export interface JmShippingMockData {
  apiKey: string;
  password: string;
  /** The store's JM client id; 4321 unless given. */
  clientId?: number;
  /** ShipmentReturn records; the list endpoint lists them by Shipment.TransactionTime. */
  shipments?: JmShippingMockRecord[];
  /** Tracking answers, by Gid. */
  tracking?: JmShippingMockRecord[];
  /** Claims, by ShipmentGid. */
  claims?: JmShippingMockRecord[];
  /** ReconciledShipment records; listed by ReconciledOn. */
  reconciled?: JmShippingMockRecord[];
  /** Rate-limited (429) answers to give before the next calls. */
  rateLimits?: number;
}

export interface JmShippingMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each read answered 200, by path. */
  readonly reads: string[];
}

const obj = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const fail = (status: number, message: string): DocMockResponse => ({ status, body: { Message: message } });
const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function jmShippingDocMock(data: JmShippingMockData): JmShippingMock {
  const reads: string[] = [];
  let limits = data.rateLimits ?? 0;
  const clientId = String(data.clientId ?? 4321);
  const shipments = data.shipments ?? [];
  const tracking = data.tracking ?? [];
  const claims = data.claims ?? [];
  const reconciled = data.reconciled ?? [];
  const basic = `Basic ${Buffer.from(`${data.apiKey}:${data.password}`, "utf8").toString("base64")}`;

  /** Checks the credentials and the rate limit, then answers. */
  function read(answer: (params: Record<string, string>) => DocMockResponse) {
    return (request: DocMockRequest, params: Record<string, string>): DocMockResponse => {
      if (!data.apiKey || request.headers.get("api_key") !== data.apiKey || request.headers.get("authorization") !== basic) return fail(400, "Invalid credentials");
      if (limits > 0) {
        limits--;
        return fail(429, "Too many requests");
      }
      if ([...request.url.searchParams.keys()].length > 0) return fail(400, "This endpoint takes no query parameters");
      const response = answer(params);
      if (response.status === 200) reads.push(request.url.pathname);
      return response;
    };
  }

  /** A client and date range, or the answer for one that doesn't read. */
  function range(params: Record<string, string>, then: (start: number, end: number) => DocMockResponse): DocMockResponse {
    if (params.clientId !== clientId) return fail(400, "Client not accessible");
    const { startDate = "", endDate = "" } = params;
    if (!DAY.test(startDate) || !DAY.test(endDate) || Number.isNaN(midnight(startDate)) || Number.isNaN(midnight(endDate))) return fail(400, "Dates must be YYYY-MM-DD");
    return then(midnight(startDate), midnight(endDate));
  }

  const within = (value: unknown, start: number, end: number) => {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    return at >= start && at <= end;
  };
  const ids = (raw: string) => raw.split(",").map((id) => id.trim());
  const matches = (id: string, n: unknown, gid: unknown) => (GUID.test(id) ? String(gid).toLowerCase() === id.toLowerCase() : /^[1-9][0-9]*$/.test(id) && String(n) === id);

  const mock = checkDocMock({
    integration: "jm_shipping_solution",
    baseUrl: BASE,
    source: { url: JM_SHIPPING_DOC_PAGES.overview, title: "JM Shipping Solution API: overview", retrievedOn: "2026-11-12", version: "v1" },
    assumptions: [
      "The Basic credentials are the API key as the user name and the password JM issued; the docs say only that the APIs take a key and a password, and the example decodes to username:password",
      "The key is a GUID, as in every example; the docs give no format for the key, the password or the client id",
      "startDate and endDate are written YYYY-MM-DD and read as midnight UTC, both ends included; the docs give their type as datetime and no format or time zone",
      "The shipment list goes by each shipment's TransactionTime, and the reconciliation list by ReconciledOn; the docs don't say which date either filters on",
      "Both lists answer every match in one answer; the docs give no paging",
      "A comma-delimited list of 20 GUIDs is accepted; the docs give no limit",
      "A shipment that has no claim answers 200 with a claim whose Id is 0, as the docs say; an unknown shipment answers 404",
      "Money is in US dollars, and times are ISO 8601 with a zone, as in every example; the docs name no currency",
      "Errors answer {Message}; the docs give 400 and 404 bodies no schema, and give no rate limit, 401 or 403",
      "The production host is another transguardian.com host JM gives with the credentials; the docs show only uat2.transguardian.com",
    ],
    routes: [
      {
        method: "GET",
        path: "/api/v1/shipment/list/{clientId}/{startDate}/{endDate}",
        documentedAt: JM_SHIPPING_DOC_PAGES.shipmentList,
        respond: read((params) =>
          range(params, (start, end) => {
            if (start > end) return { status: 200, body: { Error: [{ ErrorCode: "400", ErrorMessage: "Start date must be before end date" }], ShipmentGids: [] } };
            const gids = shipments.filter((s) => within(obj(s.Shipment).TransactionTime, start, end)).map((s) => obj(s.Shipment).Gid);
            return { status: 200, body: { Error: null, ShipmentGids: gids } };
          }),
        ),
      },
      {
        method: "GET",
        path: "/api/v1/shipment/{ids}",
        documentedAt: JM_SHIPPING_DOC_PAGES.shipments,
        respond: read((params) => {
          const asked = ids(params.ids ?? "");
          if (asked.some((id) => !GUID.test(id) && !/^[1-9][0-9]*$/.test(id))) return fail(400, "ids must be shipment ids or GUIDs");
          return { status: 200, body: asked.flatMap((id) => shipments.filter((s) => matches(id, obj(s.Shipment).Id, obj(s.Shipment).Gid))) };
        }),
      },
      {
        method: "GET",
        path: "/api/v1/shipment/track/{fullHistory}/{ids}",
        documentedAt: JM_SHIPPING_DOC_PAGES.tracking,
        respond: read((params) => {
          const full = params.fullHistory;
          if (full !== "full" && full !== "latest") return fail(400, "fullHistory must be full or latest");
          const asked = ids(params.ids ?? "");
          if (asked.some((id) => !GUID.test(id) && !/^[1-9][0-9]*$/.test(id))) return fail(400, "ids must be shipment ids or GUIDs");
          const found = asked.flatMap((id) => tracking.filter((t) => matches(id, t.Id, t.Gid)));
          const body = found.map((t) => (full === "full" || !Array.isArray(t.Activities) ? t : { ...t, Activities: t.Activities.slice(-1) }));
          return { status: 200, body };
        }),
      },
      {
        method: "GET",
        path: "/api/v1/claim/{id}",
        documentedAt: JM_SHIPPING_DOC_PAGES.claim,
        respond: read((params) => {
          const id = params.id ?? "";
          const claim = claims.find((c) => matches(id, c.ShipmentId, c.ShipmentGid));
          if (claim) return { status: 200, body: { Claim: claim, Error: null } };
          if (!shipments.some((s) => matches(id, obj(s.Shipment).Id, obj(s.Shipment).Gid))) return fail(404, "Claim not found");
          return { status: 200, body: { Claim: { Id: 0, LossType: 0, PackageContents: null, RolexOrGIAProduct: 0, PoliceReportNumber: null, ReasonForClaim: 0, Status: 2 }, Error: [] } };
        }),
      },
      {
        method: "GET",
        path: "/api/v1/shipment/reconciliation/{clientId}/{startDate}/{endDate}",
        documentedAt: JM_SHIPPING_DOC_PAGES.reconciliation,
        respond: read((params) => range(params, (start, end) => ({ status: 200, body: reconciled.filter((r) => within(r.ReconciledOn, start, end)) }))),
      },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "jm_shipping_solution",
  covers: "The JM Shipping Solution API (v1) shipment list and details, latest tracking, a shipment's claim and reconciled shipments, with basic credentials and the API_KEY header",
  watchPages: [
    JM_SHIPPING_DOC_PAGES.overview,
    JM_SHIPPING_DOC_PAGES.shipmentList,
    JM_SHIPPING_DOC_PAGES.shipments,
    JM_SHIPPING_DOC_PAGES.tracking,
    JM_SHIPPING_DOC_PAGES.claim,
    JM_SHIPPING_DOC_PAGES.reconciliation,
  ],
  docMocks: () => [jmShippingDocMock({ apiKey: "", password: "" }).mock],
} satisfies DocMockModule;
