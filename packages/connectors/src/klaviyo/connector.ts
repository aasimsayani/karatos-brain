import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { KLAVIYO_ID, KLAVIYO_PAGE_SIZES, klaviyoClient, type KlaviyoClient, type KlaviyoClientOptions, type KlaviyoReport, type KlaviyoResource, type KlaviyoRoute } from "./client.js";
import { checkKlaviyoCustomerKey } from "./customer.js";
import {
  klaviyoCampaignEvent,
  klaviyoFlowEvent,
  klaviyoGroupEvent,
  klaviyoMembershipEvent,
  klaviyoProfileEvent,
  klaviyoReportEvents,
  type KlaviyoBrainEvent,
  type KlaviyoContext,
  type KlaviyoReportWindow,
} from "./normalize.js";
import { klaviyoWebhookEvents } from "./webhooks.js";

/**
 * Reads profiles, lists and segments with their members, campaigns, flows,
 * and campaign and flow metrics. Profiles, lists, segments, campaigns and
 * flows are current state, so the historical import reads all of them; the
 * five years apply to the metrics, read one calendar year per report (the
 * longest Klaviyo allows). Incremental syncs read what changed since the last
 * pass started, the members who joined since, and the reports for the
 * calendar years touched by the last 30 days, since conversions keep being
 * attributed to a message after it is sent.
 *
 * Every list endpoint is paged with the cursor in links.next, which the
 * client checks continues the same request. Each page is one batch, so a
 * crash resumes at the next page.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client only reads. */
export const KLAVIYO_WRITES: WriteAction[] = [
  { integration: "klaviyo", name: "add_profiles_to_list", description: "Add profiles to a Klaviyo list" },
  { integration: "klaviyo", name: "trigger_flow", description: "Trigger a flow for a profile by recording the metric event that starts it" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const KLAVIYO_OVERLAP_MS = 5 * 60_000;
/** How far back an incremental pass re-reads campaign and flow figures, for conversions attributed after a send. */
export const KLAVIYO_REPORT_LOOKBACK_DAYS = 30;
/** The conversion metric Klaviyo's own reports use unless the owner names another. */
export const KLAVIYO_CONVERSION_METRIC_NAME = "Placed Order";

export const KLAVIYO_STEPS = ["profiles", "lists", "segments", "campaigns", "flows", "metrics", "campaign_values", "flow_values", "done"] as const;
export type KlaviyoStep = (typeof KLAVIYO_STEPS)[number];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface KlaviyoCursor {
  pass: "historical" | "incremental";
  step: KlaviyoStep;
  /** Klaviyo's page cursor for the current step's listing; null for its first page. */
  page: string | null;
  /** In the lists and segments steps, the groups on the current page and how far their members have been read. */
  group: { ids: string[]; index: number; member: string | null; after: string | null } | null;
  /** In the report steps, the index of the calendar year being read. */
  window: number;
  /** The conversion metric the reports use, once known. */
  metric: string | null;
  /** ISO time: a historical pass reads metrics from here; an incremental one, changes from here. */
  since: string;
  /** ISO time the pass's reports run to, fixed when it starts so a resumed pass asks the same questions. */
  through: string;
  /** ISO time the next incremental pass reads changes from. */
  nextFrom: string;
}

export interface KlaviyoConnectorOptions extends KlaviyoClientOptions {
  /** CUSTOMER_REF_KEY, which keys profile and contact references. */
  customerKey: string;
  /** KLAVIYO_CONVERSION_METRIC_ID: the metric the reports count conversions by. Found by name (Placed Order) when empty. */
  conversionMetricId?: string;
  /** Years of campaign and flow metrics the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: KlaviyoClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CURSOR = /^[A-Za-z0-9+/=_.:~-]{1,1024}$/;
const cursorOk = (v: unknown) => v === null || (typeof v === "string" && v.length <= 1024 && CURSOR.test(v));
/** A real UTC instant in the connector's own format; Date.parse alone would roll 30 February over into March. */
const timeOk = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString().slice(0, 19) === t.slice(0, 19);
const idOk = (v: unknown) => typeof v === "string" && v.length <= 64 && KLAVIYO_ID.test(v);

export function parseKlaviyoCursor(raw: string | null): KlaviyoCursor | null {
  if (raw === null) return null;
  if (raw.length > 20_000) throw new Error("Klaviyo checkpoint is not in the expected shape");
  const c = JSON.parse(raw) as KlaviyoCursor;
  const g = c?.group;
  const groupOk =
    g === null ||
    (!!g &&
      (c.step === "lists" || c.step === "segments") &&
      Array.isArray(g.ids) &&
      g.ids.length <= 100 &&
      g.ids.every(idOk) &&
      Number.isInteger(g.index) &&
      g.index >= 0 &&
      g.index <= g.ids.length &&
      cursorOk(g.member) &&
      cursorOk(g.after));
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !KLAVIYO_STEPS.includes(c.step) ||
    !cursorOk(c.page) ||
    !groupOk ||
    !Number.isInteger(c.window) ||
    c.window < 0 ||
    c.window > 50 ||
    !(c.metric === null || idOk(c.metric)) ||
    ![c.since, c.through, c.nextFrom].every(timeOk)
  ) {
    throw new Error("Klaviyo checkpoint is not in the expected shape");
  }
  return c;
}

/**
 * The calendar years a pass's reports cover, oldest first, each cut to the
 * pass's own span. Klaviyo reads a timeframe in the account's time zone, so
 * a year's edges are approximate by up to a day.
 */
export function klaviyoReportWindows(from: string, through: string): KlaviyoReportWindow[] {
  const start = Date.parse(from);
  const end = Date.parse(through);
  const windows: KlaviyoReportWindow[] = [];
  for (let year = new Date(start).getUTCFullYear(); year <= new Date(end).getUTCFullYear(); year++) {
    const s = Math.max(start, Date.UTC(year, 0, 1));
    const e = Math.min(end, Date.UTC(year + 1, 0, 1) - 1000);
    if (e > s) windows.push({ year, start: new Date(s).toISOString().replace(/\.\d{3}Z$/, "Z"), end: new Date(e).toISOString().replace(/\.\d{3}Z$/, "Z") });
  }
  return windows;
}

const GROUP_ROUTES = {
  lists: { listing: "lists", members: "listProfiles", kind: "list" },
  segments: { listing: "segments", members: "segmentProfiles", kind: "segment" },
} as const satisfies Record<string, { listing: KlaviyoRoute; members: KlaviyoRoute; kind: "list" | "segment" }>;

export function klaviyoConnector(options: KlaviyoConnectorOptions): Connector & { handleWebhook(body: unknown): KlaviyoBrainEvent[] } {
  const customerKey = checkKlaviyoCustomerKey(options.customerKey);
  const client = options.client ?? klaviyoClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const fixedMetric = options.conversionMetricId?.trim() || null;
  if (fixedMetric !== null && !idOk(fixedMetric)) throw new Error("KLAVIYO_CONVERSION_METRIC_ID must be a Klaviyo metric id");
  const iso = () => now().toISOString();
  const ctx = (): KlaviyoContext => ({ customerKey, receivedAt: iso() });

  function startHistorical(): KlaviyoCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    // The first incremental pass picks up anything changed while the import ran.
    return { pass: "historical", step: "profiles", page: null, group: null, window: 0, metric: fixedMetric, since: start.toISOString(), through: iso(), nextFrom: iso() };
  }

  function startIncremental(previous: KlaviyoCursor | null): KlaviyoCursor {
    const since = previous?.nextFrom ?? new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    const nextFrom = new Date(now().getTime() - KLAVIYO_OVERLAP_MS).toISOString();
    // A metric found by the last pass is reused; with none, this pass looks again.
    return { pass: "incremental", step: "profiles", page: null, group: null, window: 0, metric: fixedMetric ?? previous?.metric ?? null, since, through: iso(), nextFrom };
  }

  const windowsOf = (c: KlaviyoCursor) =>
    klaviyoReportWindows(c.pass === "historical" ? c.since : new Date(Date.parse(c.through) - KLAVIYO_REPORT_LOOKBACK_DAYS * 86_400_000).toISOString(), c.through);

  /** The cursor for the step after this one, with its page and group state cleared. */
  function advance(c: KlaviyoCursor, step: KlaviyoStep = KLAVIYO_STEPS[KLAVIYO_STEPS.indexOf(c.step) + 1] ?? "done"): KlaviyoCursor {
    // With a metric already known there's nothing to look up; without one there are no reports to read.
    let next: KlaviyoStep = step;
    if (next === "metrics" && c.metric !== null) next = "campaign_values";
    if ((next === "campaign_values" || next === "flow_values") && c.metric === null) next = "done";
    return { ...c, step: next, page: null, group: null, window: 0 };
  }

  const since = (c: KlaviyoCursor) => (c.pass === "incremental" ? c.since : undefined);
  const after = (field: string, c: KlaviyoCursor) => (since(c) ? `greater-than(${field},${since(c)})` : undefined);

  /** One page of a plain listing, turned into events. */
  async function listing(c: KlaviyoCursor, route: KlaviyoRoute, make: (r: KlaviyoResource, x: KlaviyoContext) => KlaviyoBrainEvent | null, params: Record<string, string | number | undefined>) {
    const page = await client.read(route, { ...params, "page[cursor]": c.page ?? undefined });
    const x = ctx();
    const events = page.data.flatMap((r) => make(r, x) ?? []);
    return { events, cursor: page.next ? { ...c, page: page.next } : advance(c) };
  }

  /** One request in the lists or segments step: a page of groups, or a page of one group's members. */
  async function groups(c: KlaviyoCursor, step: "lists" | "segments") {
    const routes = GROUP_ROUTES[step];
    const x = ctx();
    if (c.group === null) {
      const page = await client.read(routes.listing, { [`fields[${routes.kind}]`]: step === "lists" ? "name,opt_in_process,created,updated" : "name,is_active,created,updated", sort: "id", "page[cursor]": c.page ?? undefined });
      const ids = page.data.map((r) => r.id).filter(idOk) as string[];
      return { events: page.data.flatMap((r) => klaviyoGroupEvent(routes.kind, r, x) ?? []), cursor: { ...c, group: { ids: ids.slice(0, 100), index: 0, member: null, after: page.next } } };
    }
    const g = c.group;
    if (g.index >= g.ids.length) {
      return { events: [], cursor: g.after ? { ...c, page: g.after, group: null } : advance(c) };
    }
    const groupId = g.ids[g.index]!;
    const page = await client.read(
      routes.members,
      { filter: after("joined_group_at", c), "page[size]": KLAVIYO_PAGE_SIZES[routes.members], "page[cursor]": g.member ?? undefined },
      groupId,
    );
    const events = page.data.flatMap((m) => klaviyoMembershipEvent(routes.kind, groupId, m, x) ?? []);
    return { events, cursor: { ...c, group: page.next ? { ...g, member: page.next } : { ...g, index: g.index + 1, member: null } } };
  }

  /** One page of metrics, looking for the conversion metric by name. */
  async function findMetric(c: KlaviyoCursor) {
    const page = await client.read("metrics", { "fields[metric]": "name,integration,created,updated", "page[cursor]": c.page ?? undefined });
    const found = page.data.find((m) => m.attributes?.name === KLAVIYO_CONVERSION_METRIC_NAME && idOk(m.id));
    if (found) return { events: [], cursor: advance({ ...c, metric: found.id as string }) };
    return { events: [], cursor: page.next ? { ...c, page: page.next } : advance(c) };
  }

  /** One year's campaign or flow report. */
  async function report(c: KlaviyoCursor, kind: KlaviyoReport) {
    const windows = windowsOf(c);
    const window = windows[c.window];
    if (!window) return { events: [], cursor: advance(c) };
    const rows = await client.report(kind, { start: window.start, end: window.end, conversionMetricId: c.metric! });
    const x = ctx();
    const events = rows.flatMap((row) => klaviyoReportEvents(kind === "campaignValues" ? "campaign" : "flow", row, window, x));
    return { events, cursor: c.window + 1 < windows.length ? { ...c, window: c.window + 1 } : advance(c) };
  }

  async function step(c: KlaviyoCursor): Promise<{ events: KlaviyoBrainEvent[]; cursor: KlaviyoCursor }> {
    switch (c.step) {
      case "profiles":
        return listing(c, "profiles", (r, x) => klaviyoProfileEvent(r, x), {
          "fields[profile]": "email,phone_number,created,updated,subscriptions",
          "additional-fields[profile]": "subscriptions",
          filter: after("updated", c),
          sort: "updated",
          "page[size]": KLAVIYO_PAGE_SIZES.profiles,
        });
      case "lists":
      case "segments":
        return groups(c, c.step);
      case "campaigns":
        return listing(c, "campaigns", (r, x) => klaviyoCampaignEvent(r, x), {
          "fields[campaign]": "definition.name,definition.archived,created_at,updated_at",
          filter: after("updated_at", c),
          sort: "updated_at",
          "page[size]": KLAVIYO_PAGE_SIZES.campaigns,
        });
      case "flows":
        return listing(c, "flows", (r, x) => klaviyoFlowEvent(r, x), {
          "fields[flow]": "name,status,archived,trigger_type,created,updated",
          filter: after("updated", c),
          sort: "updated",
          "page[size]": KLAVIYO_PAGE_SIZES.flows,
        });
      case "metrics":
        return findMetric(c);
      case "campaign_values":
        return report(c, "campaignValues");
      case "flow_values":
        return report(c, "flowValues");
      case "done":
        return { events: [], cursor: c };
    }
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseKlaviyoCursor(context.cursor);
    let cursor: KlaviyoCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }
    while (cursor.step !== "done") {
      const result = await step(cursor);
      cursor = result.cursor;
      yield { events: result.events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "klaviyo",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => klaviyoWebhookEvents(body, ctx()),
    writes: KLAVIYO_WRITES,
  };
}
