import { createHash } from "node:crypto";
import { INTEGRATIONS, type IntegrationSpec } from "./integrations.js";
import type { IssueTracker } from "./issue-tracker.js";

/**
 * Vendor docs watch: every day, fetch each integration's public API
 * changelog, compare it with the last saved copy, and open one issue per
 * change with the changed lines as evidence. A vendor that changes again
 * while its issue is still open gets a comment on that issue, not a new one.
 */

export interface VendorDocsTarget {
  integration: string;
  name: string;
  url: string;
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
  now?: () => Date;
}

export const changeMarker = (integration: string) => `<!-- vendor-docs:${integration} -->`;
export const movedMarker = (integration: string) => `<!-- vendor-docs-moved:${integration} -->`;

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

function changeBody(target: VendorDocsTarget, diff: TextDiff, at: string): string {
  return [
    changeMarker(target.integration),
    `The ${target.name} API changelog changed. Seen ${at} at ${target.url}`,
    "",
    "Lines removed (-) and added (+):",
    "",
    evidence(diff),
    "",
    "**To do**",
    "- [ ] Read the change and decide whether the connector is affected",
    "- [ ] If it is, open a fix PR with a test that reproduces the new behavior",
    "- [ ] Note anything a client or onboarding needs in the runbook's connection guide",
    "",
    "Opened by the daily vendor docs watch.",
  ].join("\n");
}

/** "fetch failed" alone says nothing; Node keeps the real reason (DNS, TLS, proxy) in the cause chain. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error && parts.length < 4; e = e.cause) parts.push(e.message);
  return parts.join(": ") || String(error);
}

async function watchOne(target: VendorDocsTarget, options: VendorDocsWatchOptions, at: string): Promise<WatchOutcome> {
  const { integration } = target;
  let response: Response;
  try {
    response = await options.fetch(target.url, { headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1" } });
  } catch (error) {
    return { integration, status: "error", detail: errorChain(error) };
  }

  if (response.status === 404 || response.status === 410) {
    const existing = await options.issues.findOpen(movedMarker(integration));
    if (existing) return { integration, status: "moved", issue: existing.number, detail: `HTTP ${response.status}` };
    const issue = await options.issues.open(
      `Vendor changelog moved: ${target.name}`,
      [
        movedMarker(integration),
        `The ${target.name} API changelog at ${target.url} answered HTTP ${response.status} on ${at}.`,
        "",
        "Find the new changelog URL and update `changelog` for this integration in `packages/core/src/integrations.ts`. Until then, changes to this API go unnoticed.",
        "",
        "Opened by the daily vendor docs watch.",
      ].join("\n"),
    );
    return { integration, status: "moved", issue, detail: `HTTP ${response.status}` };
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
  const existing = await options.issues.findOpen(changeMarker(integration));
  let issue: number;
  if (existing) {
    issue = existing.number;
    await options.issues.comment(issue, [`Changed again, seen ${at}.`, "", evidence(diff)].join("\n"));
  } else {
    issue = await options.issues.open(`Vendor docs changed: ${target.name}`, changeBody(target, diff, at));
  }
  // Save only after the issue exists, so a failed run reports the change next time.
  await options.store.put(snapshot);
  return { integration, status: "changed", issue, detail: `${diff.added.length} added, ${diff.removed.length} removed` };
}

/** Checks every target once. One target failing never stops the others. */
export async function runVendorDocsWatch(options: VendorDocsWatchOptions): Promise<WatchOutcome[]> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const outcomes: WatchOutcome[] = [];
  for (const target of options.targets) {
    try {
      outcomes.push(await watchOne(target, options, at));
    } catch (error) {
      outcomes.push({ integration: target.integration, status: "error", detail: (error as Error).message });
    }
  }
  return outcomes;
}
