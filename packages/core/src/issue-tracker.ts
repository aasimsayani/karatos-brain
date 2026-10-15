/**
 * Where scheduled checks (the vendor docs watch, the nightly sandbox run)
 * file what they find. Each finding carries a marker in its issue body, so a
 * check can find its own open issue and add to it instead of opening another.
 */

export interface TrackedIssue {
  number: number;
  body: string;
}

export interface IssueTracker {
  /** The open issue whose body carries this marker, if any. */
  findOpen(marker: string): Promise<TrackedIssue | null>;
  open(title: string, body: string): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
}

export interface GitHubIssueTrackerOptions {
  /** owner/name */
  repo: string;
  token: string;
  /** Labels for new issues. The first is the one searched for open issues, so each check needs its own. */
  labels: [string, ...string[]];
  fetch?: typeof globalThis.fetch;
}

/** Files issues through the GitHub REST API. */
export function gitHubIssueTracker(options: GitHubIssueTrackerOptions): IssueTracker {
  const fetch = options.fetch ?? globalThis.fetch;
  const labels = options.labels;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`https://api.github.com/repos/${options.repo}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} answered ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  return {
    async findOpen(marker) {
      for (let page = 1; ; page++) {
        const issues = (await api(
          `/issues?state=open&labels=${encodeURIComponent(labels[0]!)}&per_page=100&page=${page}`,
        )) as { number: number; body: string | null; pull_request?: unknown }[];
        const match = issues.find((i) => !i.pull_request && (i.body ?? "").includes(marker));
        if (match) return { number: match.number, body: match.body ?? "" };
        if (issues.length < 100) return null;
      }
    },
    async open(title, body) {
      const created = (await api("/issues", { method: "POST", body: JSON.stringify({ title, body, labels }) })) as {
        number: number;
      };
      return created.number;
    },
    async comment(issue, body) {
      await api(`/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
  };
}
