import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS,
  changeMarker,
  diffLines,
  movedMarker,
  pageText,
  runVendorDocsWatch,
  sha256Hex,
  vendorDocsTargets,
  type IssueTracker,
  type DocsSnapshot,
  type SnapshotStore,
  type VendorDocsTarget,
} from "../src/index.js";

const page = (name: string) => readFileSync(new URL(`./fixtures/vendor-docs/${name}.html`, import.meta.url), "utf8");
const V1 = page("changelog-v1");
const V1_REBUILT = page("changelog-v1-rebuilt");
const V2 = page("changelog-v2");

const TARGET: VendorDocsTarget = { integration: "demo", name: "Demo", url: "https://docs.demo.example/changelog" };
const NOW = () => new Date("2026-10-11T14:00:00Z");

class MemoryStore implements SnapshotStore {
  readonly snapshots = new Map<string, DocsSnapshot>();
  async get(id: string) {
    return this.snapshots.get(id) ?? null;
  }
  async put(s: DocsSnapshot) {
    this.snapshots.set(s.integration, s);
  }
}

class MemoryTracker implements IssueTracker {
  readonly issues: { number: number; title: string; body: string; comments: string[]; open: boolean }[] = [];
  async findOpen(marker: string) {
    const issue = this.issues.find((i) => i.open && i.body.includes(marker));
    return issue ? { number: issue.number, body: issue.body } : null;
  }
  async open(title: string, body: string) {
    const number = this.issues.length + 1;
    this.issues.push({ number, title, body, comments: [], open: true });
    return number;
  }
  async comment(number: number, body: string) {
    this.issues.find((i) => i.number === number)!.comments.push(body);
  }
}

/** Serves the given pages in turn: a string is a 200 body, a number a status, an Error a network failure. */
function sitePages(...responses: (string | number | Error)[]) {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === "number" ? new Response("gone", { status: next }) : new Response(next, { status: 200 });
  };
}

async function watch(fetch: typeof globalThis.fetch, store: MemoryStore, issues: MemoryTracker, targets = [TARGET]) {
  return runVendorDocsWatch({ targets, fetch, store, issues, now: NOW });
}

describe("the catalog's changelogs", () => {
  it("are https URLs or null, and a self-serve public API without one says why", () => {
    for (const spec of INTEGRATIONS) {
      if (spec.changelog !== null) expect(spec.changelog, spec.id).toMatch(/^https:\/\/[^\s]+$/);
      if (spec.access === "public_api" && spec.testWith === "sandbox" && spec.status !== "deferred") {
        if (spec.changelog === null) expect(spec.note, `${spec.id} needs a changelog, or a note saying why not`).toMatch(/changelog/i);
      }
    }
    const { targets, unwatched } = vendorDocsTargets();
    expect(targets.length + unwatched.length).toBe(INTEGRATIONS.length);
    expect(unwatched).toContain("bank_statements");
    expect(targets.find((t) => t.integration === "shopify")?.url).toBe("https://shopify.dev/changelog");
    expect(new Set(targets.map((t) => t.url)).size).toBe(targets.length);
  });
});

describe("pageText", () => {
  it("keeps the readable text and drops scripts, styles, comments and markup", () => {
    const text = pageText(V1);
    expect(text.split("\n")).toEqual([
      "Docs & guides",
      "API changelog",
      "2026-10-01",
      "Added the fulfillment_holds field to orders.",
      "Rate limits stay at 40 requests per second.",
      "2026-09-01",
      "Version 2026-07 is now the oldest supported version.",
      "© Demo Inc — all rights reserved —",
    ]);
    expect(text).not.toMatch(/a1b2c3|color:red|logo|JavaScript|build 2026/);
  });

  it("ignores rebuilds that change only scripts and comments", () => {
    expect(sha256Hex(pageText(V1_REBUILT))).toBe(sha256Hex(pageText(V1)));
  });

  it("leaves unknown entities alone", () => {
    expect(pageText("<p>&unknown; &lt;b&gt; &#39;x&#39;</p>")).toBe("&unknown; <b> 'x'");
  });
});

describe("diffLines", () => {
  it("lists added and removed lines in page order, counting repeats", () => {
    expect(diffLines("a\nb\nb\nc", "a\nb\nc\nd")).toEqual({ added: ["d"], removed: ["b"], truncated: false });
  });

  it("caps long diffs and says so", () => {
    const after = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    expect(diffLines("", after, 3)).toEqual({ added: ["line 0", "line 1", "line 2"], removed: [""], truncated: true });
  });
});

describe("runVendorDocsWatch", () => {
  it("baselines a new page, then reports nothing while it is unchanged or only rebuilt", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const fetch = sitePages(V1, V1, V1_REBUILT);
    expect(await watch(fetch, store, issues)).toEqual([{ integration: "demo", status: "baseline" }]);
    expect(await watch(fetch, store, issues)).toEqual([{ integration: "demo", status: "unchanged" }]);
    expect(await watch(fetch, store, issues)).toEqual([{ integration: "demo", status: "unchanged" }]);
    expect(issues.issues).toEqual([]);
    expect(store.snapshots.get("demo")).toMatchObject({ url: TARGET.url, fetchedAt: "2026-10-11T14:00:00.000Z" });
  });

  it("opens one issue for a change, with the changed lines as evidence", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const fetch = sitePages(V1, V2, V2, V2);
    await watch(fetch, store, issues);
    const [outcome] = await watch(fetch, store, issues);
    expect(outcome).toEqual({ integration: "demo", status: "changed", issue: 1, detail: "3 added, 1 removed" });
    await watch(fetch, store, issues);
    await watch(fetch, store, issues);
    expect(issues.issues).toHaveLength(1);
    const [issue] = issues.issues;
    expect(issue!.title).toBe("Vendor docs changed: Demo");
    expect(issue!.body).toContain(changeMarker("demo"));
    expect(issue!.body).toContain("+ Breaking: the orders.total field is removed in version 2027-01. Use orders.total_price.");
    expect(issue!.body).toContain("- Rate limits stay at 40 requests per second.");
    expect(issue!.body).toContain("+ Rate limits drop to 20 requests per second.");
    expect(issue!.body).toContain(TARGET.url);
    expect(issue!.comments).toEqual([]);
  });

  it("comments on the open issue when the page changes again, and opens a new one once it is closed", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const fetch = sitePages(V1, V2, V1, V2);
    await watch(fetch, store, issues);
    await watch(fetch, store, issues);
    expect((await watch(fetch, store, issues))[0]).toMatchObject({ status: "changed", issue: 1 });
    expect(issues.issues).toHaveLength(1);
    expect(issues.issues[0]!.comments[0]).toMatch(/^Changed again, seen 2026-10-11T14:00:00.000Z/);
    issues.issues[0]!.open = false;
    expect((await watch(fetch, store, issues))[0]).toMatchObject({ status: "changed", issue: 2 });
  });

  it("fences page text so it can't break out of the evidence block", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    await watch(sitePages("<p>old</p>", "<p>````\n@everyone ``` </p>"), store, issues);
    await watch(sitePages("<p>````\n@everyone ``` </p>"), store, issues);
    expect(issues.issues[0]!.body).toContain("`````diff");
  });

  it("re-baselines when the watched URL changes", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    await watch(sitePages(V1), store, issues);
    const moved = { ...TARGET, url: "https://docs.demo.example/v2/changelog" };
    expect(await watch(sitePages(V2), store, issues, [moved])).toEqual([{ integration: "demo", status: "baseline" }]);
    expect(issues.issues).toEqual([]);
  });

  it("opens one 'moved' issue for a 404 and nothing for transient failures", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    expect((await watch(sitePages(404), store, issues))[0]).toEqual({ integration: "demo", status: "moved", issue: 1, detail: "HTTP 404" });
    expect((await watch(sitePages(410), store, issues))[0]).toMatchObject({ status: "moved", issue: 1 });
    expect(issues.issues).toHaveLength(1);
    expect(issues.issues[0]!.title).toBe("Vendor changelog moved: Demo");
    expect(issues.issues[0]!.body).toContain(movedMarker("demo"));
    expect((await watch(sitePages(503), store, issues))[0]).toEqual({ integration: "demo", status: "error", detail: "HTTP 503" });
    expect((await watch(sitePages(new Error("ECONNRESET")), store, issues))[0]).toEqual({
      integration: "demo",
      status: "error",
      detail: "ECONNRESET",
    });
    const proxied = new Error("fetch failed", { cause: new Error("Request was cancelled.", { cause: new Error("Proxy response (403)") }) });
    expect((await watch(sitePages(proxied), store, issues))[0]!.detail).toBe("fetch failed: Request was cancelled.: Proxy response (403)");
    expect(issues.issues).toHaveLength(1);
  });

  it("keeps going when one target's issue can't be filed, and reports the change again next run", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const other = { integration: "other", name: "Other", url: "https://other.example/changelog" };
    await watch(sitePages(V1), store, issues, [TARGET, other]);
    const failing = Object.assign(new MemoryTracker(), {
      open: async () => {
        throw new Error("GitHub POST /issues answered 500");
      },
    });
    const outcomes = await watch(sitePages(V2), store, failing, [TARGET, other]);
    expect(outcomes.map((o) => o.status)).toEqual(["error", "error"]);
    expect(store.snapshots.get("demo")!.sha256).toBe(sha256Hex(pageText(V1)));
    expect((await watch(sitePages(V2), store, issues, [TARGET]))[0]).toMatchObject({ status: "changed" });
  });

  it("uses the real clock when none is given", async () => {
    const outcomes = await runVendorDocsWatch({ targets: [TARGET], fetch: sitePages(V1), store: new MemoryStore(), issues: new MemoryTracker() });
    expect(outcomes[0]!.status).toBe("baseline");
  });
});
