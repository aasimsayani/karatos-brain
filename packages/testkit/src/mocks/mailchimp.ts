import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * The Mailchimp Marketing API (3.0) reads the connector uses: ping,
 * audiences, audience members, campaigns and campaign reports, built from
 * the API reference. Data is synthetic.
 */
export const MAILCHIMP_TEST_DC = "us21";
const API = `https://${MAILCHIMP_TEST_DC}.api.mailchimp.com/3.0`;
const DOCS = "https://mailchimp.com/developer/marketing/api";

export interface MailchimpList {
  id: string;
  web_id: number;
  name: string;
  contact: { company: string; address1: string; city: string; country: string };
  date_created: string;
  double_optin: boolean;
  stats: { member_count: number; unsubscribe_count: number; cleaned_count: number; campaign_count: number };
}

export interface MailchimpMember {
  id: string;
  email_address: string;
  unique_email_id: string;
  contact_id: string;
  full_name: string;
  status: "subscribed" | "unsubscribed" | "cleaned" | "pending" | "transactional" | "archived";
  merge_fields: Record<string, unknown>;
  timestamp_opt: string;
  last_changed: string;
  member_rating: number;
  location: { latitude: number; longitude: number; country_code: string };
  tags: { id: number; name: string }[];
  list_id: string;
}

export interface MailchimpCampaign {
  id: string;
  web_id: number;
  type: "regular" | "plaintext" | "absplit" | "rss" | "variate";
  create_time: string;
  send_time: string;
  status: "save" | "paused" | "schedule" | "sending" | "sent";
  emails_sent: number;
  recipients: { list_id: string; list_name: string; segment_text: string };
  settings: { subject_line: string; title: string; from_name: string; reply_to: string };
}

export interface MailchimpReport {
  id: string;
  campaign_title: string;
  list_id: string;
  subject_line: string;
  emails_sent: number;
  abuse_reports: number;
  unsubscribed: number;
  send_time: string;
  bounces: { hard_bounce: number; soft_bounce: number; syntax_errors: number };
  opens: { opens_total: number; unique_opens: number; open_rate: number; last_open: string };
  clicks: { clicks_total: number; unique_clicks: number; unique_subscriber_clicks: number; click_rate: number; last_click: string };
  ecommerce: { total_orders: number; total_spent: number; total_revenue: number; currency_code: string };
}

/** Mailchimp's +00:00 times. */
const mcTime = (minutes: number, start: string) => synthetic.isoTime(minutes, start).replace(".000Z", "+00:00");
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

export const mailchimpList = fixtureBuilder<MailchimpList>((n) => ({
  id: `a1b2c3d${n}e`,
  web_id: 100 + n,
  name: n === 1 ? "Store customers" : `Test audience ${n}`,
  contact: { company: "Test Jewelers", address1: "1 Test Street", city: "Testville", country: "US" },
  date_created: mcTime(n * 1440, "2021-03-01T00:00:00Z"),
  double_optin: n % 2 === 0,
  stats: { member_count: 3, unsubscribe_count: 1, cleaned_count: 0, campaign_count: 2 },
}));

export const mailchimpMember = fixtureBuilder<MailchimpMember>((n) => ({
  id: hex(n, 32),
  email_address: synthetic.email(n),
  unique_email_id: hex(n, 10),
  contact_id: hex(n, 32),
  full_name: synthetic.name(n),
  status: "subscribed",
  merge_fields: { FNAME: "Test", LNAME: `Customer${n}`, PHONE: synthetic.phone(n), BIRTHDAY: "05/14" },
  timestamp_opt: mcTime(n * 60, "2024-05-01T00:00:00Z"),
  last_changed: mcTime(n * 60, "2026-09-01T00:00:00Z"),
  member_rating: 3,
  location: { latitude: 0, longitude: 0, country_code: "US" },
  tags: [{ id: 1, name: "Bridal" }],
  list_id: "a1b2c3d1e",
}));

export const mailchimpCampaign = fixtureBuilder<MailchimpCampaign>((n) => ({
  id: `c0ffee${n}0`,
  web_id: 500 + n,
  type: "regular",
  create_time: mcTime(n * 1440, "2026-06-01T00:00:00Z"),
  send_time: mcTime(n * 1440 + 60, "2026-06-01T00:00:00Z"),
  status: "sent",
  emails_sent: 3,
  recipients: { list_id: "a1b2c3d1e", list_name: "Store customers", segment_text: "" },
  settings: { subject_line: `Test subject ${n}`, title: n % 2 ? "Holiday gift guide" : "Bridal event invite", from_name: "Test Jewelers", reply_to: "store@example.test" },
}));

/** The report Mailchimp would give a campaign, with figures that differ by campaign. */
export function mailchimpReportFor(campaign: MailchimpCampaign, n = 1): MailchimpReport {
  return {
    id: campaign.id,
    campaign_title: campaign.settings.title,
    list_id: campaign.recipients.list_id,
    subject_line: campaign.settings.subject_line,
    emails_sent: campaign.emails_sent,
    abuse_reports: 0,
    unsubscribed: 1,
    send_time: campaign.send_time,
    bounces: { hard_bounce: 0, soft_bounce: 1, syntax_errors: 0 },
    opens: { opens_total: 4 * n, unique_opens: 2, open_rate: 0.66, last_open: campaign.send_time },
    clicks: { clicks_total: n, unique_clicks: 1, unique_subscriber_clicks: 1, click_rate: 0.33, last_click: campaign.send_time },
    ecommerce: { total_orders: 1, total_spent: 1250.5, total_revenue: 1250.5, currency_code: "USD" },
  };
}

export interface MailchimpMockData {
  lists: MailchimpList[];
  /** Members by audience id. */
  members: Record<string, MailchimpMember[]>;
  campaigns: MailchimpCampaign[];
  /** Reports by campaign id; built from the campaign when absent. */
  reports?: Record<string, MailchimpReport>;
  /** The key the mock accepts; any Basic auth when absent. */
  apiKey?: string;
  /** Rows per page the mock caps at, to exercise paging. Defaults to 1000. */
  pageCap?: number;
  /** How many of the next requests answer 429. */
  rateLimited?: number;
}

const problem = (status: number, title: string, detail: string): DocMockResponse => ({ status, body: { type: "https://mailchimp.com/developer/marketing/docs/errors/", title, status, detail, instance: "00000000-0000-4000-8000-000000000000" } });

/** Mailchimp's `fields`: keeps only the named dot paths, at any depth and inside arrays. */
function pick(value: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const byHead = new Map<string, string[]>();
  for (const path of paths) {
    const [head, ...rest] = path.split(".");
    if (head) byHead.set(head, [...(byHead.get(head) ?? []), rest.join(".")]);
  }
  const out: Record<string, unknown> = {};
  for (const [head, rests] of byHead) {
    if (!(head in value)) continue;
    const v = value[head];
    if (rests.includes("")) out[head] = v;
    else if (Array.isArray(v)) out[head] = v.map((item) => pick(item as Record<string, unknown>, rests));
    else if (v && typeof v === "object") out[head] = pick(v as Record<string, unknown>, rests);
  }
  return out;
}

export interface MailchimpMock {
  api: DocMock;
  fetch: DocMockFetch;
}

export function mailchimpDocMock(data: MailchimpMockData): MailchimpMock {
  const denied = (headers: Headers) => {
    const auth = headers.get("authorization") ?? "";
    const key = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8").split(":")[1];
    if (data.apiKey !== undefined && key !== data.apiKey) return problem(401, "API Key Invalid", "Your API key may be invalid, or you've attempted to access the wrong datacenter.");
    if (data.rateLimited) {
      data.rateLimited--;
      return problem(429, "Too Many Requests", "You have exceeded the limit of 10 simultaneous connections.");
    }
    return null;
  };
  const paged = (key: string, all: Record<string, unknown>[], url: URL): DocMockResponse => {
    const count = Number(url.searchParams.get("count") ?? 10);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isInteger(count) || count < 1 || count > 1000 || !Number.isInteger(offset) || offset < 0) return problem(400, "Invalid Resource", "count must be 1 to 1000 and offset 0 or more");
    const page = all.slice(offset, offset + Math.min(count, data.pageCap ?? 1000));
    const body = { [key]: page, total_items: all.length };
    const fields = url.searchParams.get("fields");
    return { status: 200, body: fields ? pick(body, fields.split(",")) : body };
  };
  const since = (url: URL, name: string) => {
    const value = url.searchParams.get(name);
    return value === null ? null : Date.parse(value);
  };

  const api = checkDocMock({
    integration: "mailchimp",
    baseUrl: API,
    source: { url: `${DOCS}/`, title: "Mailchimp Marketing API reference", retrievedOn: "2026-10-30", version: "3.0" },
    auth: "basic",
    assumptions: [
      "fields keeps only the named dot paths, at any depth, including inside arrays",
      "since_last_changed and since_send_time are inclusive",
      "Members sorted by last_changed ASC and campaigns by send_time ASC keep a stable order while paging by offset",
      "A 429 carries no Retry-After",
      "A report's ecommerce block is present, with zeros, when the store isn't connected",
    ],
    routes: [
      {
        method: "GET",
        path: "/ping",
        documentedAt: `${DOCS}/ping/ping/`,
        respond: (request) => denied(request.headers) ?? { status: 200, body: { health_status: "Everything's Chimpy!" } },
      },
      {
        method: "GET",
        path: "/lists",
        documentedAt: `${DOCS}/lists/get-lists-info/`,
        respond: (request) => denied(request.headers) ?? paged("lists", data.lists as unknown as Record<string, unknown>[], request.url),
      },
      {
        method: "GET",
        path: "/lists/{list_id}/members",
        documentedAt: `${DOCS}/list-members/list-members-info/`,
        respond(request, params) {
          const no = denied(request.headers);
          if (no) return no;
          if (!data.lists.some((l) => l.id === params.list_id)) return problem(404, "Resource Not Found", "The requested resource could not be found.");
          const from = since(request.url, "since_last_changed");
          if (Number.isNaN(from)) return problem(400, "Invalid Resource", "since_last_changed must be ISO 8601");
          let members = [...(data.members[params.list_id!] ?? [])].filter((m) => from === null || Date.parse(m.last_changed) >= from);
          if (request.url.searchParams.get("sort_field") === "last_changed") members = members.sort((a, b) => Date.parse(a.last_changed) - Date.parse(b.last_changed));
          return paged("members", members as unknown as Record<string, unknown>[], request.url);
        },
      },
      {
        method: "GET",
        path: "/campaigns",
        documentedAt: `${DOCS}/campaigns/list-campaigns/`,
        respond(request) {
          const no = denied(request.headers);
          if (no) return no;
          const from = since(request.url, "since_send_time");
          if (Number.isNaN(from)) return problem(400, "Invalid Resource", "since_send_time must be ISO 8601");
          const status = request.url.searchParams.get("status");
          let campaigns = data.campaigns.filter((c) => (status === null || c.status === status) && (from === null || Date.parse(c.send_time) >= from));
          if (request.url.searchParams.get("sort_field") === "send_time") campaigns = campaigns.sort((a, b) => Date.parse(a.send_time) - Date.parse(b.send_time));
          return paged("campaigns", campaigns as unknown as Record<string, unknown>[], request.url);
        },
      },
      {
        method: "GET",
        path: "/reports/{campaign_id}",
        documentedAt: `${DOCS}/reports/get-campaign-report/`,
        respond(request, params) {
          const no = denied(request.headers);
          if (no) return no;
          const campaign = data.campaigns.find((c) => c.id === params.campaign_id);
          if (!campaign) return problem(404, "Resource Not Found", "The requested resource could not be found.");
          const report = (data.reports?.[campaign.id] ?? mailchimpReportFor(campaign)) as unknown as Record<string, unknown>;
          const fields = request.url.searchParams.get("fields");
          return { status: 200, body: fields ? pick(report, fields.split(",")) : report };
        },
      },
    ],
  });
  return { api, fetch: docMockFetch(api) };
}

export default {
  integration: "mailchimp",
  covers: "Mailchimp's ping, audience, member, campaign and campaign report reads (Marketing API 3.0)",
  watchPages: [
    "https://mailchimp.com/developer/marketing/api/",
    "https://mailchimp.com/developer/marketing/api/ping/ping/",
    "https://mailchimp.com/developer/marketing/api/lists/get-lists-info/",
    "https://mailchimp.com/developer/marketing/api/list-members/list-members-info/",
    "https://mailchimp.com/developer/marketing/api/campaigns/list-campaigns/",
    "https://mailchimp.com/developer/marketing/api/reports/get-campaign-report/",
  ],
  docMocks: () => [mailchimpDocMock({ lists: [], members: {}, campaigns: [] }).api],
} satisfies DocMockModule;
