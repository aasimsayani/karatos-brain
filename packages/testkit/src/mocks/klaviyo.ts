import { createHash } from "node:crypto";
import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Klaviyo's JSON:API (revision 2026-10-15) as the connector reads it:
 * profiles, lists and segments with their member ids, campaigns, flows,
 * metrics, and the campaign and flow values reports, built from Klaviyo's
 * API reference. Data is synthetic. A free Klaviyo account replaces this
 * mock with the nightly run once its private key is set up.
 */
const DOCS = "https://developers.klaviyo.com/en";
const API = "https://a.klaviyo.com";
const REVISION = "2026-10-15";

/** Unix-second-free ISO times, as Klaviyo writes them: an explicit +00:00 offset. */
const klaviyoIso = (iso: string) => iso.replace(/\.\d{3}Z$/, "+00:00");
const time = (n: number) => klaviyoIso(synthetic.isoTime(n * 60));
const pad = (n: number, width: number) => String(n).padStart(width, "0");

export interface KlaviyoMockProfile {
  id: string;
  email?: string | null;
  phone_number?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  organization?: string | null;
  location?: Record<string, unknown> | null;
  properties?: Record<string, unknown>;
  created: string;
  updated: string;
  subscriptions?: { email?: { marketing?: { consent?: string; can_receive_email_marketing?: boolean } }; sms?: { marketing?: { consent?: string; can_receive_sms_marketing?: boolean } } };
}

export interface KlaviyoMockMember {
  profileId: string;
  joinedAt: string;
}

export interface KlaviyoMockList {
  id: string;
  name: string;
  opt_in_process: "single_opt_in" | "double_opt_in";
  created: string;
  updated: string;
  members: KlaviyoMockMember[];
}

export interface KlaviyoMockSegment {
  id: string;
  name: string;
  is_active: boolean;
  created: string;
  updated: string;
  /** Segment conditions can name a person; the connector must never ask for them. */
  definition: Record<string, unknown>;
  members: KlaviyoMockMember[];
}

export interface KlaviyoMockCampaign {
  id: string;
  definition: { name: string; archived: boolean; description?: string; builder?: string };
  created_at: string;
  updated_at: string;
}

export interface KlaviyoMockFlow {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  trigger_type: string;
  created: string;
  updated: string;
}

export interface KlaviyoMockMetric {
  id: string;
  name: string;
  integration: { name: string; category: string };
  created: string;
  updated: string;
}

/** One message's figures on one channel, as of a send time; a report includes it when the time falls in its timeframe. */
export interface KlaviyoMockValues {
  at: string;
  groupings: Record<string, string>;
  statistics: Record<string, number>;
}

export interface KlaviyoMockData {
  /** The private key requests must carry. */
  apiKey: string;
  profiles?: KlaviyoMockProfile[];
  lists?: KlaviyoMockList[];
  segments?: KlaviyoMockSegment[];
  campaigns?: KlaviyoMockCampaign[];
  flows?: KlaviyoMockFlow[];
  metrics?: KlaviyoMockMetric[];
  campaignValues?: KlaviyoMockValues[];
  flowValues?: KlaviyoMockValues[];
  /** 429s to answer before the next reads, in order. */
  rateLimits?: { retryAfter?: number }[];
  /** Metrics per page; Klaviyo's is 200. Smaller in tests, to page. */
  metricsPageSize?: number;
}

export const klaviyoProfile = fixtureBuilder<KlaviyoMockProfile>((n) => ({
  id: `01JTESTPROFILE${pad(n, 12)}`,
  email: synthetic.email(n),
  phone_number: `+1212555${pad(100 + (n % 100), 4)}`,
  first_name: "Test",
  last_name: `Customer ${n}`,
  organization: "Test Organization",
  location: { address1: `${n} Test Street`, city: "Testville", country: "United States", zip: "00000", latitude: 0, longitude: 0 },
  properties: { ring_size: "6", anniversary: "2020-06-01", note: "Synthetic custom property" },
  created: time(n),
  updated: time(n + 30),
  subscriptions: { email: { marketing: { consent: n % 2 ? "SUBSCRIBED" : "UNSUBSCRIBED", can_receive_email_marketing: n % 2 === 1 } }, sms: { marketing: { consent: "NEVER_SUBSCRIBED", can_receive_sms_marketing: false } } },
}));

export const klaviyoList = fixtureBuilder<KlaviyoMockList>((n) => ({ id: `TL${pad(n, 4)}`, name: `Test list ${n}`, opt_in_process: n % 2 ? "single_opt_in" : "double_opt_in", created: time(n), updated: time(n + 5), members: [] }));

export const klaviyoSegment = fixtureBuilder<KlaviyoMockSegment>((n) => ({
  id: `TS${pad(n, 4)}`,
  name: `Test segment ${n}`,
  is_active: true,
  created: time(n),
  updated: time(n + 5),
  definition: { condition_groups: [{ conditions: [{ type: "profile-property", property: "email", filter: { operator: "equals", value: synthetic.email(900 + n) } }] }] },
  members: [],
}));

export const klaviyoCampaign = fixtureBuilder<KlaviyoMockCampaign>((n) => ({
  id: `TC${pad(n, 4)}`,
  definition: { name: `Test campaign ${n}`, archived: false, description: "Synthetic campaign description", builder: "omnichannel" },
  created_at: time(n),
  updated_at: time(n + 10),
}));

export const klaviyoFlow = fixtureBuilder<KlaviyoMockFlow>((n) => ({ id: `TF${pad(n, 4)}`, name: `Test flow ${n}`, status: "live", archived: false, trigger_type: "Added to List", created: time(n), updated: time(n + 10) }));

export const klaviyoMetric = fixtureBuilder<KlaviyoMockMetric>((n) => ({ id: `TM${pad(n, 4)}`, name: `Test metric ${n}`, integration: { name: "API", category: "API" }, created: time(n), updated: time(n) }));

const error = (status: number, code: string, detail: string, parameter?: string): DocMockResponse => ({
  status,
  body: { errors: [{ id: "00000000-0000-4000-8000-000000000000", status, code, title: code === "invalid" ? "Invalid input." : "Error", detail, ...(parameter ? { source: { parameter } } : {}) }] },
});

/** What each documented list endpoint accepts. */
interface ListingSpec {
  type: string;
  fieldsKey?: string;
  extraParams?: string[];
  filters: Record<string, string[]>;
  sorts: string[];
  /** Page size: [default, max]. No page[size] parameter when absent. */
  pageSize?: [number, number];
  fixedPageSize?: number;
}

const LISTINGS: Record<string, ListingSpec> = {
  profiles: { type: "profile", fieldsKey: "fields[profile]", extraParams: ["additional-fields[profile]"], filters: { updated: ["greater-than", "less-than"], created: ["greater-than", "less-than"] }, sorts: ["id", "created", "updated"], pageSize: [20, 100] },
  lists: { type: "list", fieldsKey: "fields[list]", filters: { updated: ["greater-than"], created: ["greater-than"] }, sorts: ["id", "created", "name", "updated"], pageSize: [10, 10] },
  segments: { type: "segment", fieldsKey: "fields[segment]", filters: { updated: ["greater-than"], created: ["greater-than"] }, sorts: ["id", "created", "name", "updated"], pageSize: [10, 10] },
  members: { type: "profile", filters: { joined_group_at: ["greater-than", "greater-or-equal", "less-than", "less-or-equal"] }, sorts: ["joined_group_at"], pageSize: [20, 100] },
  campaigns: { type: "campaign", fieldsKey: "fields[campaign]", filters: { updated_at: ["greater-than", "greater-or-equal", "less-than", "less-or-equal"], created_at: ["greater-than", "greater-or-equal", "less-than", "less-or-equal"] }, sorts: ["id", "created_at", "name", "updated_at"], pageSize: [100, 100] },
  flows: { type: "flow", fieldsKey: "fields[flow]", filters: { updated: ["greater-than", "greater-or-equal", "less-than", "less-or-equal", "equals"], created: ["greater-than", "greater-or-equal", "less-than", "less-or-equal", "equals"] }, sorts: ["id", "created", "name", "status", "trigger_type", "updated"], pageSize: [50, 50] },
  metrics: { type: "metric", fieldsKey: "fields[metric]", filters: {}, sorts: [], fixedPageSize: 200 },
};

const FILTER = /^([a-z-]+)\(([a-z_]+),([0-9T:.+Z-]{10,40})\)$/;

/** Sparse fieldsets: only the attributes asked for, with dotted names reaching into objects. */
function sparse(attributes: Record<string, unknown>, fields: string | null): Record<string, unknown> {
  if (fields === null) return attributes;
  const out: Record<string, unknown> = {};
  for (const name of fields.split(",")) {
    const [head, ...rest] = name.split(".");
    if (!(head! in attributes)) continue;
    if (rest.length === 0) out[head!] = attributes[head!];
    else {
      const inner = (attributes[head!] ?? {}) as Record<string, unknown>;
      out[head!] = { ...((out[head!] as object) ?? {}), ...sparse(inner, rest.join(".")) };
    }
  }
  return out;
}

const cursorFor = (offset: number, binding: string) => Buffer.from(JSON.stringify({ o: offset, q: binding })).toString("base64url");
function offsetOf(cursor: string, binding: string): number | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown; q?: unknown };
    return typeof c.o === "number" && Number.isInteger(c.o) && c.o >= 0 && c.q === binding ? c.o : null;
  } catch {
    return null;
  }
}

/** The documented statistics for both values reports. */
const STATISTICS = new Set([
  "average_order_value", "bounce_rate", "bounced", "bounced_or_failed", "bounced_or_failed_rate", "click_rate", "click_to_open_rate", "clicks", "clicks_unique",
  "conversion_rate", "conversion_uniques", "conversion_value", "conversions", "delivered", "delivery_rate", "failed", "failed_rate", "message_segment_count_sum",
  "open_rate", "opens", "opens_unique", "recipients", "revenue_per_recipient", "spam_complaint_rate", "spam_complaints", "text_message_credit_usage_amount",
  "text_message_roi", "text_message_spend", "unsubscribe_rate", "unsubscribe_uniques", "unsubscribes",
]);
const REPORTS = {
  campaign: { type: "campaign-values-report", groupBy: ["campaign_id", "campaign_message_id", "campaign_message_name", "group", "group_name", "send_channel", "tag_id", "tag_name", "text_message_format", "variation", "variation_name"], required: ["campaign_id", "campaign_message_id"], defaults: ["campaign_id", "campaign_message_id", "send_channel"] },
  flow: { type: "flow-values-report", groupBy: ["flow_id", "flow_message_id", "flow_message_name", "flow_name", "send_channel", "tag_id", "tag_name", "text_message_format", "variation", "variation_name"], required: ["flow_id", "flow_message_id"], defaults: ["flow_id", "flow_message_id", "send_channel"] },
} as const;

export interface KlaviyoMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Report bodies received, in order, as parsed JSON. */
  readonly reports: { kind: "campaign" | "flow"; body: Record<string, unknown> }[];
}

export function klaviyoDocMock(data: KlaviyoMockData): KlaviyoMock {
  const limits = [...(data.rateLimits ?? [])];
  const reports: KlaviyoMock["reports"] = [];

  /** Auth and revision, then a queued 429 if any; undefined when the request may go on. */
  function gate(request: DocMockRequest): DocMockResponse | undefined {
    if (request.headers.get("authorization") !== `Klaviyo-API-Key ${data.apiKey}`) return error(401, "not_authenticated", "Authentication credentials were not provided.");
    const revision = request.headers.get("revision");
    if (!revision || !/^\d{4}-\d{2}-\d{2}(\.pre)?$/.test(revision)) return error(400, "invalid", "A revision header is required.", "revision");
    if (revision > REVISION) return error(400, "invalid", `Revision ${revision} does not exist.`, "revision");
    const limit = limits.shift();
    if (limit) return { status: 429, body: error(429, "throttled", "Request was throttled.").body, ...(limit.retryAfter !== undefined ? { headers: { "retry-after": String(limit.retryAfter) } } : {}) };
    return undefined;
  }

  /** One page of a JSON:API listing, with sparse fieldsets, one filter, a sort and a cursor bound to the query. */
  function listing(request: DocMockRequest, specName: keyof typeof LISTINGS, rows: { id: string; attributes: Record<string, unknown>; times: Record<string, string> }[]): DocMockResponse {
    const blocked = gate(request);
    if (blocked) return blocked;
    const spec = LISTINGS[specName]!;
    const q = request.url.searchParams;
    const known = new Set(["filter", "page[cursor]", ...(spec.sorts.length ? ["sort"] : []), ...(spec.pageSize ? ["page[size]"] : []), ...(spec.fieldsKey ? [spec.fieldsKey] : []), ...(spec.extraParams ?? [])]);
    for (const key of q.keys()) if (!known.has(key)) return error(400, "invalid", `'${key.slice(0, 40)}' is not a valid parameter for this endpoint.`, key.slice(0, 40));
    let selected = [...rows];
    const filter = q.get("filter");
    if (filter !== null) {
      const m = FILTER.exec(filter.slice(0, 120));
      const ops = m ? spec.filters[m[2]!] : undefined;
      const at = m ? Date.parse(m[3]!) : Number.NaN;
      if (!m || !ops?.includes(m[1]!) || Number.isNaN(at)) return error(400, "invalid", "Invalid filter provided.", "filter");
      const [, op, field] = m;
      selected = selected.filter((r) => {
        const v = Date.parse(r.times[field!] ?? "");
        return op === "greater-than" ? v > at : op === "greater-or-equal" ? v >= at : op === "less-than" ? v < at : op === "less-or-equal" ? v <= at : v === at;
      });
    }
    const sort = q.get("sort");
    if (sort !== null) {
      const field = sort.replace(/^-/, "");
      if (!spec.sorts.includes(field)) return error(400, "invalid", "Invalid sort provided.", "sort");
      const sign = sort.startsWith("-") ? -1 : 1;
      selected.sort((a, b) => sign * (field === "id" || field === "name" ? String(a.times[field] ?? a.id).localeCompare(String(b.times[field] ?? b.id)) : Date.parse(a.times[field] ?? "") - Date.parse(b.times[field] ?? "")) || a.id.localeCompare(b.id));
    } else selected.sort((a, b) => a.id.localeCompare(b.id));
    let size = spec.fixedPageSize ?? spec.pageSize?.[0] ?? 20;
    if (specName === "metrics" && data.metricsPageSize) size = data.metricsPageSize;
    const sizeParam = q.get("page[size]");
    if (sizeParam !== null) {
      size = Number(sizeParam);
      if (!Number.isInteger(size) || size < 1 || size > spec.pageSize![1]) return error(400, "invalid", `page[size] must be between 1 and ${spec.pageSize![1]}.`, "page[size]");
    }
    const others = [...q.entries()].filter(([k]) => k !== "page[cursor]").sort(([a], [b]) => a.localeCompare(b));
    const binding = createHash("sha256").update(`${request.url.pathname}?${JSON.stringify(others)}`).digest("hex").slice(0, 16);
    const cursor = q.get("page[cursor]");
    const offset = cursor === null ? 0 : offsetOf(cursor, binding);
    if (offset === null) return error(400, "invalid", "Invalid page cursor.", "page[cursor]");
    const fields = spec.fieldsKey ? q.get(spec.fieldsKey) : null;
    const page = selected.slice(offset, offset + size).map((r) => (specName === "members" ? { type: "profile", id: r.id } : { type: spec.type, id: r.id, attributes: sparse(r.attributes, fields), links: { self: `${API}/api/${specName}/${r.id}/` } }));
    const more = offset + size < selected.length;
    const link = (o: number) => {
      const params = new URLSearchParams(others);
      params.set("page[cursor]", cursorFor(o, binding));
      return `${API}${request.url.pathname}?${params.toString()}`;
    };
    return { status: 200, body: { data: page, links: { self: request.url.toString(), next: more ? link(offset + size) : null, prev: offset > 0 ? link(Math.max(0, offset - size)) : null } } };
  }

  function profileRows(request: DocMockRequest) {
    // Subscriptions come back only when asked for with additional-fields, as the docs describe.
    const extra = (request.url.searchParams.get("additional-fields[profile]") ?? "").split(",");
    return (data.profiles ?? []).map((p) => {
      const { id, subscriptions, ...attributes } = p;
      return { id, attributes: { ...attributes, ...(extra.includes("subscriptions") && subscriptions ? { subscriptions } : {}) }, times: { updated: p.updated, created: p.created } };
    });
  }

  function members(request: DocMockRequest, groups: readonly { id: string; members: KlaviyoMockMember[] }[], groupId: string | undefined): DocMockResponse {
    const group = groups.find((g) => g.id === groupId);
    if (!group) {
      const blocked = gate(request);
      return blocked ?? error(404, "not_found", "A group with the given id does not exist.");
    }
    return listing(request, "members", group.members.map((m) => ({ id: m.profileId, attributes: {}, times: { joined_group_at: m.joinedAt } })));
  }

  function report(request: DocMockRequest, kind: "campaign" | "flow"): DocMockResponse {
    const blocked = gate(request);
    if (blocked) return blocked;
    if (request.url.search) return error(400, "invalid", "This mock models no report query parameters.");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.body || "{}") as Record<string, unknown>;
    } catch {
      return error(400, "invalid", "Malformed JSON.");
    }
    reports.push({ kind, body });
    const spec = REPORTS[kind];
    const d = body.data as { type?: unknown; attributes?: { statistics?: unknown; timeframe?: { start?: unknown; end?: unknown; key?: unknown }; conversion_metric_id?: unknown; group_by?: unknown; filter?: unknown } } | undefined;
    if (d?.type !== spec.type) return error(400, "invalid", `data.type must be ${spec.type}.`);
    const a = d.attributes ?? {};
    if (!Array.isArray(a.statistics) || a.statistics.length === 0 || !a.statistics.every((s) => typeof s === "string" && STATISTICS.has(s))) return error(400, "invalid", "Invalid statistics.");
    const start = typeof a.timeframe?.start === "string" ? Date.parse(a.timeframe.start) : Number.NaN;
    const end = typeof a.timeframe?.end === "string" ? Date.parse(a.timeframe.end) : Number.NaN;
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return error(400, "invalid", "This mock models custom timeframes only, with a start before the end.");
    if (end - start > 366 * 86_400_000) return error(400, "invalid", "The timeframe can span a year at most.");
    if (typeof a.conversion_metric_id !== "string" || !(data.metrics ?? []).some((m) => m.id === a.conversion_metric_id)) return error(400, "invalid", "Invalid conversion metric.");
    const groupBy = a.group_by === undefined ? [...spec.defaults] : a.group_by;
    if (!Array.isArray(groupBy) || !groupBy.every((g) => typeof g === "string" && (spec.groupBy as readonly string[]).includes(g)) || !spec.required.every((r) => groupBy.includes(r))) return error(400, "invalid", "Invalid group_by.");
    if (a.filter !== undefined) return error(400, "invalid", "This mock models no report filters.");
    const rows = (kind === "campaign" ? data.campaignValues : data.flowValues) ?? [];
    const results = rows
      .filter((r) => Date.parse(r.at) >= start && Date.parse(r.at) <= end)
      .map((r) => ({
        groupings: Object.fromEntries(Object.entries(r.groupings).filter(([k]) => groupBy.includes(k))),
        statistics: Object.fromEntries((a.statistics as string[]).map((s) => [s, r.statistics[s] ?? 0])),
      }));
    return { status: 200, body: { data: { type: spec.type, id: "00000000-0000-4000-8000-000000000002", attributes: { results } }, links: { self: request.url.toString() } } };
  }

  const ref = (page: string) => `${DOCS}/reference/${page}`;
  const api = checkDocMock({
    integration: "klaviyo",
    baseUrl: API,
    source: { url: `${DOCS}/docs/authenticate_`, title: "Klaviyo API: authenticate API requests (revision 2026-10-15)", retrievedOn: "2026-10-22", version: REVISION },
    assumptions: [
      "links.next is an absolute URL carrying every parameter of the request it continues plus page[cursor], and the cursor is only valid with those same parameters",
      "fields[profile]=email,phone_number,created,updated,subscriptions with additional-fields[profile]=subscriptions returns only those attributes; names, location and properties never arrive",
      "Consent is one of SUBSCRIBED, UNSUBSCRIBED and NEVER_SUBSCRIBED (the reference gives SUBSCRIBED as an example and lists no enum)",
      "Profile and list relationship endpoints return ids only and include a profile that joined before a joined_group_at filter's time never",
      "The values reports answer every row in one response (the spec lists a page_cursor parameter but no links.next), and take timeframe start and end as UTC ISO times though Klaviyo reads them in the account's time zone",
      "conversion_value is in the account's currency, in major units, so it becomes cents by multiplying by 100",
      "Klaviyo answers 400 for a parameter an endpoint doesn't document and 404 for a list or segment id that doesn't exist",
      "Klaviyo answers 400 when the revision header is missing or names a revision that doesn't exist",
      "A 429 carries Retry-After in whole seconds; the values reports allow 1 a second, 2 a minute and 225 a day",
      "Lists and segments take page[size] up to 10 and sort by id",
      "Metrics come 200 a page with no page[size] parameter, and the conversion metric Klaviyo's own reports use is named Placed Order",
    ],
    routes: [
      { method: "GET", path: "/api/profiles/", documentedAt: ref("get_profiles"), respond: (request) => listing(request, "profiles", profileRows(request)) },
      {
        method: "GET",
        path: "/api/lists/",
        documentedAt: ref("get_lists"),
        respond: (request) => listing(request, "lists", (data.lists ?? []).map(({ id, members: _, ...attributes }) => ({ id, attributes, times: { updated: attributes.updated, created: attributes.created, name: attributes.name, id } }))),
      },
      { method: "GET", path: "/api/lists/{id}/relationships/profiles/", documentedAt: ref("get_profile_ids_for_list"), respond: (request, params) => members(request, data.lists ?? [], params.id) },
      {
        method: "GET",
        path: "/api/segments/",
        documentedAt: ref("get_segments"),
        respond: (request) => listing(request, "segments", (data.segments ?? []).map(({ id, members: _, ...attributes }) => ({ id, attributes, times: { updated: attributes.updated, created: attributes.created, name: attributes.name, id } }))),
      },
      { method: "GET", path: "/api/segments/{id}/relationships/profiles/", documentedAt: ref("get_profile_ids_for_segment"), respond: (request, params) => members(request, data.segments ?? [], params.id) },
      {
        method: "GET",
        path: "/api/campaigns/",
        documentedAt: ref("get_campaigns"),
        respond: (request) => listing(request, "campaigns", (data.campaigns ?? []).map(({ id, ...attributes }) => ({ id, attributes, times: { updated_at: attributes.updated_at, created_at: attributes.created_at, name: attributes.definition.name, id } }))),
      },
      {
        method: "GET",
        path: "/api/flows/",
        documentedAt: ref("get_flows"),
        respond: (request) => listing(request, "flows", (data.flows ?? []).map(({ id, ...attributes }) => ({ id, attributes, times: { updated: attributes.updated, created: attributes.created, name: attributes.name, id } }))),
      },
      { method: "GET", path: "/api/metrics/", documentedAt: ref("get_metrics"), respond: (request) => listing(request, "metrics", (data.metrics ?? []).map(({ id, ...attributes }) => ({ id, attributes, times: {} }))) },
      { method: "POST", path: "/api/campaign-values-reports/", documentedAt: ref("query_campaign_values"), respond: (request) => report(request, "campaign") },
      { method: "POST", path: "/api/flow-values-reports/", documentedAt: ref("query_flow_values"), respond: (request) => report(request, "flow") },
    ],
  });

  return { api, fetch: docMockFetch(api), reports };
}
