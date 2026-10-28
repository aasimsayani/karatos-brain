/**
 * Checks that the live website shows what main builds. The page carries two
 * meta tags written by site/build.ts: karatos-connected (the ids of every
 * built connector) and karatos-mapped (how many systems are on the map).
 * When a deploy fails, the old page keeps being served and quietly falls
 * behind; this compares the live tags with a fresh build and files an issue
 * until they match again.
 */
import type { IssueTracker } from "../packages/core/src/issue-tracker.js";

export interface SiteFacts {
  /** Built connector ids, or null when the page has no karatos-connected tag. */
  connected: string[] | null;
  mapped: number | null;
}

const meta = (html: string, name: string): string | null => {
  const m = new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html);
  return m ? m[1]! : null;
};

export function readSiteFacts(html: string): SiteFacts {
  const connected = meta(html, "karatos-connected");
  const mapped = meta(html, "karatos-mapped");
  return {
    connected: connected === null ? null : connected.split(",").filter((id) => /^[a-z][a-z0-9_]{0,63}$/.test(id)),
    mapped: mapped !== null && /^\d{1,6}$/.test(mapped) ? Number(mapped) : null,
  };
}

export interface SiteComparison {
  fresh: boolean;
  /** Built on main but not on the live page. */
  missing: string[];
  /** On the live page but no longer built on main. */
  extra: string[];
  problems: string[];
}

export function compareSite(live: SiteFacts, built: SiteFacts): SiteComparison {
  if (!built.connected || built.mapped === null) throw new Error("the built page has no karatos-connected or karatos-mapped tag; build it with site/build.ts");
  if (!live.connected) {
    return { fresh: false, missing: [...built.connected], extra: [], problems: ["The live page has no connector list, so it was deployed before this check existed or from an old build."] };
  }
  const liveSet = new Set(live.connected);
  const builtSet = new Set(built.connected);
  const missing = built.connected.filter((id) => !liveSet.has(id));
  const extra = live.connected.filter((id) => !builtSet.has(id));
  const problems: string[] = [];
  if (missing.length) problems.push(`The live page is missing ${missing.length} connected ${missing.length === 1 ? "system" : "systems"} that main has built.`);
  if (extra.length) problems.push(`The live page shows ${extra.length} connected ${extra.length === 1 ? "system" : "systems"} that main no longer has.`);
  if (live.mapped !== built.mapped) problems.push(`The live page maps ${live.mapped ?? "an unknown number of"} systems; main maps ${built.mapped}.`);
  return { fresh: problems.length === 0, missing, extra, problems };
}

export const SITE_MARKER = "<!-- site-freshness -->";

export type SiteCheckResult =
  | { status: "fresh"; closed: number | null }
  | { status: "stale" | "down"; problems: string[]; issue: number };

export interface SiteCheckOptions {
  url: string;
  /** The page main builds, as site/build.ts wrote it. */
  builtHtml: string;
  issues: IssueTracker;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

function issueBody(url: string, problems: string[], comparison: SiteComparison | null, at: string): string {
  const list = (ids: string[]) => ids.map((id) => `\`${id}\``).join(", ");
  return [
    SITE_MARKER,
    `The live website at ${url} is behind main (checked ${at}).`,
    "",
    ...problems.map((p) => `- ${p}`),
    ...(comparison?.missing.length ? ["", `Missing from the live page: ${list(comparison.missing)}`] : []),
    ...(comparison?.extra.length ? ["", `On the live page but not on main: ${list(comparison.extra)}`] : []),
    "",
    "Usually a deploy failed and the old page is still being served. To fix it:",
    "- [ ] Open the website service on Railway and read the latest deployment's build log",
    "- [ ] Check the service still deploys from `main` with `RAILWAY_DOCKERFILE_PATH=site/Dockerfile`",
    "- [ ] Fix what the log names, or redeploy from main",
    "",
    "This issue closes itself once the live page matches main.",
  ].join("\n");
}

/** Compares the live page with main's build, and opens, updates or closes the one site-freshness issue. */
export async function checkSiteFreshness(options: SiteCheckOptions): Promise<SiteCheckResult> {
  const fetch = options.fetch ?? globalThis.fetch;
  const at = (options.now ?? (() => new Date()))().toISOString();
  const built = readSiteFacts(options.builtHtml);
  let problems: string[];
  let comparison: SiteComparison | null = null;
  let status: "stale" | "down" = "stale";
  try {
    const response = await fetch(options.url, { headers: { accept: "text/html" }, redirect: "follow" });
    if (!response.ok) {
      status = "down";
      problems = [`The live page answered HTTP ${response.status}.`];
    } else {
      comparison = compareSite(readSiteFacts(await response.text()), built);
      problems = comparison.problems;
    }
  } catch (error) {
    if (error instanceof Error && /built page/.test(error.message)) throw error;
    status = "down";
    problems = [`The live page could not be reached: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}.`];
  }
  const open = await options.issues.findOpen(SITE_MARKER);
  if (problems.length === 0) {
    if (open) await options.issues.close(open.number, `The live page matches main again as of ${at}. Closing; a new gap opens a new issue.`);
    return { status: "fresh", closed: open?.number ?? null };
  }
  const body = issueBody(options.url, problems, comparison, at);
  if (open) {
    await options.issues.comment(open.number, body.replace(SITE_MARKER, "").trimStart());
    return { status, problems, issue: open.number };
  }
  return { status, problems, issue: await options.issues.open(status === "down" ? "The website is not answering" : "The live website is behind main", body) };
}
