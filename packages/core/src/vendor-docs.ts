import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { CONNECTOR_CATALOG } from "./catalog/index.js";
import { INTEGRATIONS, type IntegrationSpec } from "./integrations.js";
import type { IssueTracker } from "./issue-tracker.js";

/**
 * Vendor docs watch: every day, fetch each integration's public API
 * changelog and the pages its doc mock was built from, and compare each with
 * the last saved copy. Everything found goes on one long-running issue: a
 * comment per run with the changed lines as evidence, and a ranked checklist
 * in the issue body with one row per vendor. Vendors a client uses come
 * first, then other built connectors, then the rest of the catalog. Ticking a
 * row marks it handled, and the next run drops it.
 */

export interface VendorDocsTarget {
  /** Snapshot and issue key: the integration id, or `id:page` for a doc-mock source page. */
  integration: string;
  name: string;
  url: string;
  /**
   * Set when the page is one a doc-derived mock was built from, rather than
   * a changelog. A change then means the mock may no longer match the API.
   */
  mock?: {
    /** Catalog id of the integration the mock stands in for. */
    integration: string;
    /** The day the mock last matched the page, as YYYY-MM-DD. */
    retrievedOn: string;
  };
}

/** Integrations with a public changelog to watch, and those without one. */
export function vendorDocsTargets(specs: readonly IntegrationSpec[] = INTEGRATIONS): {
  targets: VendorDocsTarget[];
  unwatched: string[];
} {
  const targets: VendorDocsTarget[] = [];
  const unwatched: string[] = [];
  for (const spec of specs) {
    if (spec.changelog === null) unwatched.push(spec.id);
    else targets.push({ integration: spec.id, name: spec.name, url: spec.changelog });
  }
  return { targets, unwatched };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", mdash: "—", ndash: "–" };

/**
 * Readable text of a changelog page, one block per line. Scripts, styles and
 * markup are dropped so build hashes and nonces don't look like changes.
 */
export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|br|hr|section|article|header|footer|pre|table|dt|dd|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (match, name: string) => {
      const lower = name.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower]!;
      if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return match;
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface TextDiff {
  added: string[];
  removed: string[];
  /** True when more lines changed than the limit allowed through. */
  truncated: boolean;
}

/** Lines added and removed between two versions of a page, in page order. */
export function diffLines(before: string, after: string, limit = 40): TextDiff {
  const count = (lines: string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const minus = (lines: string[], other: Map<string, number>) => {
    const remaining = new Map(other);
    return lines.filter((line) => {
      const n = remaining.get(line) ?? 0;
      if (n > 0) {
        remaining.set(line, n - 1);
        return false;
      }
      return true;
    });
  };
  const a = before.split("\n");
  const b = after.split("\n");
  const added = minus(b, count(a));
  const removed = minus(a, count(b));
  return {
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
    truncated: added.length > limit || removed.length > limit,
  };
}

export interface DocsSnapshot {
  integration: string;
  url: string;
  sha256: string;
  text: string;
  fetchedAt: string;
}

export interface SnapshotStore {
  get(integration: string): Promise<DocsSnapshot | null>;
  put(snapshot: DocsSnapshot): Promise<void>;
}

export type WatchStatus = "baseline" | "unchanged" | "changed" | "moved" | "error";

export interface WatchOutcome {
  integration: string;
  status: WatchStatus;
  issue?: number;
  detail?: string;
}

export interface VendorDocsWatchOptions {
  targets: readonly VendorDocsTarget[];
  fetch: typeof globalThis.fetch;
  store: SnapshotStore;
  issues: IssueTracker;
  /** Catalog ids a client syncs today. They rank first; the issue doesn't say which they are. */
  inUse?: ReadonlySet<string>;
  /** Catalog ids with a built connector. Defaults to the connector catalog. */
  built?: ReadonlySet<string>;
  now?: () => Date;
}

/** Marks the one issue the watch keeps. */
export const WATCH_MARKER = "<!-- vendor-docs-watch -->";
export const WATCH_TITLE = "Vendor docs watch";
const STATE_PREFIX = "<!-- vendor-docs-state:";
/** GitHub rejects an issue body over 65,536 characters; this leaves room to spare. */
export const WATCH_BODY_LIMIT = 60_000;
/** Pages listed under a vendor's row; the rest are counted. */
const PAGES_SHOWN = 3;
const ROW_MARKER = (vendor: string) => `<!-- row:${vendor} -->`;
/** Evidence links kept per page; older ones stay in the issue's comments. */
const EVIDENCE_KEPT = 3;

/** Fences text in more backticks than it contains, so page text can't break out of the block. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}diff\n${text}\n${ticks}`;
}

function evidence(diff: TextDiff): string {
  const lines = [...diff.removed.map((l) => `- ${l}`), ...diff.added.map((l) => `+ ${l}`)].join("\n");
  const more = diff.truncated ? "\n\nMore lines changed than are shown here; open the page for the rest." : "";
  return `${fence(lines || "(only whitespace or ordering changed)")}${more}`;
}

/** "fetch failed" alone says nothing; Node keeps the real reason (DNS, TLS, proxy) in the cause chain. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error && parts.length < 4; e = e.cause) parts.push(e.message);
  return parts.join(": ") || String(error);
}

/** A change or move found on one page this run, not yet on the issue. */
interface Finding {
  target: VendorDocsTarget;
  status: "changed" | "moved";
  detail: string;
  /** The changed lines, or what the page answered. */
  evidence: string;
  /** Saved once the finding is on the issue, so a failed run reports it again. */
  snapshot?: DocsSnapshot;
}

interface PageState {
  url: string;
  status: "changed" | "moved";
  /** Set for a page a doc mock was built from. */
  mock?: string;
  firstSeen: string;
  lastSeen: string;
  times: number;
  evidence: string[];
}

interface VendorState {
  name: string;
  pages: Record<string, PageState>;
}

export type WatchState = Record<string, VendorState>;

/** The catalog id a target belongs to: its own, or the one its doc mock stands in for. */
export const vendorOf = (target: VendorDocsTarget) => target.mock?.integration ?? target.integration;

/** The saved state in a watch issue's body, minus the rows someone ticked. */
export function readWatchBody(body: string): WatchState {
  const start = body.indexOf(STATE_PREFIX);
  if (start === -1) return {};
  const end = body.indexOf(" -->", start);
  let state: WatchState;
  try {
    const packed = Buffer.from(body.slice(start + STATE_PREFIX.length, end), "base64");
    // Deflated since bodies hit GitHub's size limit; a plain JSON state is read too.
    const json = packed[0] === 0x7b ? packed.toString("utf8") : inflateRawSync(packed).toString("utf8");
    state = JSON.parse(json) as WatchState;
  } catch {
    return {};
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) return {};
  for (const line of body.split("\n")) {
    const ticked = /^- \[[xX]\] .*<!-- row:([a-z0-9_]+) -->$/.exec(line);
    if (ticked) delete state[ticked[1]!];
  }
  return state;
}

const day = (iso: string) => iso.slice(0, 10);

/** Ranks vendors: in use, then built, then the rest; newest change first within each. */
export function rankVendors(state: WatchState, inUse: ReadonlySet<string>, built: ReadonlySet<string>): string[] {
  const tier = (vendor: string) => (inUse.has(vendor) ? 0 : built.has(vendor) ? 1 : 2);
  const latest = (vendor: string) => Object.values(state[vendor]!.pages).reduce((a, p) => (p.lastSeen > a ? p.lastSeen : a), "");
  return Object.keys(state).sort(
    (a, b) => tier(a) - tier(b) || latest(b).localeCompare(latest(a)) || state[a]!.name.localeCompare(state[b]!.name) || a.localeCompare(b),
  );
}

function row(vendor: string, v: VendorState, built: boolean, withPages: boolean): string[] {
  const pages = Object.values(v.pages);
  const changed = pages.filter((p) => p.status === "changed").length;
  const moved = pages.length - changed;
  const counts = [changed ? `${changed} ${changed === 1 ? "page" : "pages"} changed` : "", moved ? `${moved} moved` : ""].filter(Boolean).join(", ");
  const first = pages.reduce((a, p) => (p.firstSeen < a ? p.firstSeen : a), pages[0]!.firstSeen);
  const last = pages.reduce((a, p) => (p.lastSeen > a ? p.lastSeen : a), pages[0]!.lastSeen);
  const seen = day(first) === day(last) ? `seen ${day(last)}` : `first seen ${day(first)}, last ${day(last)}`;
  const lines = [`- [ ] **${v.name}** (${built ? "built" : "not built yet"}): ${counts}, ${seen} ${ROW_MARKER(vendor)}`];
  if (!withPages) return lines;
  const newest = pages.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.url.localeCompare(b.url));
  for (const p of newest.slice(0, PAGES_SHOWN)) {
    const what = p.mock ? `doc mock page, read ${p.mock}` : "changelog";
    const status = p.status === "moved" ? "moved" : p.times > 1 ? `changed ${p.times} times` : "changed";
    const links = p.evidence.map((url, i) => `[${i === 0 ? "evidence" : i + 1}](${url})`).join(" ");
    lines.push(`  - ${status}: ${p.url} (${what})${links ? ` ${links}` : ""}`);
  }
  if (newest.length > PAGES_SHOWN) lines.push(`  - and ${newest.length - PAGES_SHOWN} more, in the comments`);
  return lines;
}

export function renderWatchBody(state: WatchState, inUse: ReadonlySet<string>, built: ReadonlySet<string>, at: string): string {
  const vendors = rankVendors(state, inUse, built);
  const head = [
    WATCH_MARKER,
    "Every vendor whose API changelog, or a page its doc mock was built from, changed or moved since its row was last ticked. Vendors our clients use come first, then built connectors, then the rest of the catalog, newest change first.",
    "",
    "**To work a row:** read its evidence and decide whether the connector or mock is affected. If it is, open a fix PR with a test that reproduces the new behavior, and update the mock's `retrievedOn`. A moved page needs its new URL in `packages/core/src/integrations.ts` or the mock. Then tick the row; the next run drops it, and a later change brings it back.",
    "",
    vendors.length === 0 ? "Nothing waiting." : `**${vendors.length} ${vendors.length === 1 ? "vendor" : "vendors"} waiting**`,
    "",
  ];
  const tail = ["", `Updated ${at} by the daily vendor docs watch.`, `${STATE_PREFIX}${deflateRawSync(Buffer.from(JSON.stringify(state), "utf8")).toString("base64")} -->`];
  const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  const room = WATCH_BODY_LIMIT - size(head) - size(tail);
  // Rows with their pages if they fit; else bare rows; else the top rows, saying how many wait below.
  let rows = vendors.flatMap((v) => row(v, state[v]!, built.has(v), true));
  if (size(rows) > room) rows = vendors.flatMap((v) => row(v, state[v]!, built.has(v), false));
  if (size(rows) > room) {
    const shown: string[] = [];
    let i = 0;
    for (; i < vendors.length; i++) {
      const next = row(vendors[i]!, state[vendors[i]!]!, built.has(vendors[i]!), false);
      if (size(shown) + size(next) + 100 > room) break;
      shown.push(...next);
    }
    rows = [...shown, `- and ${vendors.length - i} more ${vendors.length - i === 1 ? "vendor" : "vendors"}, listed here as the ones above are ticked`];
  }
  return [...head, ...rows, ...tail].join("\n");
}

function findingNote(f: Finding): string {
  const t = f.target;
  if (f.status === "moved") {
    return t.mock
      ? `A page the ${t.name} doc mock was built from, ${t.url}, ${f.evidence}. Find where it moved and update \`packages/testkit/src/mocks/${t.mock.integration}.ts\`.`
      : `The ${t.name} API changelog at ${t.url} ${f.evidence}. Find the new URL and update \`changelog\` for this integration in \`packages/core/src/integrations.ts\`.`;
  }
  const lead = t.mock
    ? `A page the ${t.name} doc mock was built from changed: ${t.url}. The mock matches the version read on ${t.mock.retrievedOn}, so it may no longer match the real API.`
    : `The ${t.name} API changelog changed: ${t.url}`;
  return `${lead}\n\nLines removed (-) and added (+):\n\n${f.evidence}`;
}

async function watchOne(target: VendorDocsTarget, options: VendorDocsWatchOptions, at: string): Promise<WatchOutcome | Finding> {
  const { integration } = target;
  let response: Response;
  try {
    response = await options.fetch(target.url, { headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1" } });
  } catch (error) {
    return { integration, status: "error", detail: errorChain(error) };
  }

  if (response.status === 404 || response.status === 410) {
    return { target, status: "moved", detail: `HTTP ${response.status}`, evidence: `answered HTTP ${response.status} on ${at}` };
  }
  if (!response.ok) return { integration, status: "error", detail: `HTTP ${response.status}` };

  const text = pageText(await response.text());
  const snapshot: DocsSnapshot = { integration, url: target.url, sha256: sha256Hex(text), text, fetchedAt: at };
  const previous = await options.store.get(integration);

  // A new or re-pointed target sets the baseline without raising anything.
  if (previous === null || previous.url !== target.url) {
    await options.store.put(snapshot);
    return { integration, status: "baseline" };
  }
  if (previous.sha256 === snapshot.sha256) return { integration, status: "unchanged" };

  const diff = diffLines(previous.text, text);
  return { target, status: "changed", detail: `${diff.added.length} added, ${diff.removed.length} removed`, evidence: evidence(diff), snapshot };
}

const isFinding = (r: WatchOutcome | Finding): r is Finding => "target" in r;

/**
 * Checks every target once, then puts what it found on the watch issue in
 * one comment and one body update. One target failing never stops the
 * others; if the issue can't be updated, the changes are reported again
 * next run.
 */
export async function runVendorDocsWatch(options: VendorDocsWatchOptions): Promise<WatchOutcome[]> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const inUse = options.inUse ?? new Set<string>();
  const built = options.built ?? new Set(Object.keys(CONNECTOR_CATALOG));
  const results: (WatchOutcome | Finding)[] = [];
  for (const target of options.targets) {
    try {
      results.push(await watchOne(target, options, at));
    } catch (error) {
      results.push({ integration: target.integration, status: "error", detail: (error as Error).message });
    }
  }
  const findings = results.filter(isFinding);

  let issue: number | undefined;
  let failure: string | undefined;
  try {
    const existing = await options.issues.findOpen(WATCH_MARKER);
    const state = existing ? readWatchBody(existing.body) : {};
    let link: string | undefined;
    if (findings.length > 0 && existing) {
      link = (await options.issues.comment(existing.number, runComment(findings, at))) ?? undefined;
    }
    for (const f of findings) {
      const vendor = vendorOf(f.target);
      const v = (state[vendor] ??= { name: f.target.name, pages: {} });
      v.name = f.target.name;
      const before = v.pages[f.target.integration];
      v.pages[f.target.integration] = {
        url: f.target.url,
        status: f.status,
        ...(f.target.mock ? { mock: f.target.mock.retrievedOn } : {}),
        firstSeen: before?.firstSeen ?? at,
        lastSeen: at,
        times: (before?.times ?? 0) + 1,
        evidence: [...(link ? [link] : []), ...(before?.evidence ?? [])].slice(0, EVIDENCE_KEPT),
      };
    }
    const body = renderWatchBody(state, inUse, built, at);
    if (existing) {
      // An unchanged body (nothing found, nothing ticked) isn't written back.
      if (body.split("\n").slice(0, -2).join("\n") !== existing.body.split("\n").slice(0, -2).join("\n")) {
        await options.issues.update(existing.number, body);
      }
      issue = existing.number;
    } else if (findings.length > 0) {
      issue = await options.issues.open(WATCH_TITLE, body);
      await options.issues.comment(issue, runComment(findings, at));
    }
    // Save only after the issue has the change, so a failed run reports it next time.
    for (const f of findings) if (f.snapshot) await options.store.put(f.snapshot);
  } catch (error) {
    failure = errorChain(error);
  }

  return results.map((r): WatchOutcome => {
    if (!isFinding(r)) return r;
    const integration = r.target.integration;
    if (failure !== undefined) return { integration, status: "error", detail: `${r.status}, but the watch issue couldn't be updated: ${failure}` };
    return { integration, status: r.status, ...(issue !== undefined ? { issue } : {}), detail: r.detail };
  });
}

function runComment(findings: readonly Finding[], at: string): string {
  return [
    `Seen ${at}.`,
    ...findings.flatMap((f) => ["", `### ${f.target.name}`, "", findingNote(f)]),
  ].join("\n");
}
