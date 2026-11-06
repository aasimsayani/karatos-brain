import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS,
  WATCH_BODY_LIMIT,
  WATCH_MARKER,
  diffLines,
  pageText,
  rankVendors,
  readWatchBody,
  renderWatchBody,
  runVendorDocsWatch,
  sha256Hex,
  vendorDocsTargets,
  vendorOf,
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
  updates = 0;
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
    const issue = this.issues.find((i) => i.number === number)!;
    issue.comments.push(body);
    return `https://tracker.example/issues/${number}#c${issue.comments.length}`;
  }
  async update(number: number, body: string) {
    this.updates++;
    this.issues.find((i) => i.number === number)!.body = body;
  }
  async close(number: number, body: string) {
    await this.comment(number, body);
    this.issues.find((i) => i.number === number)!.open = false;
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

async function watch(
  fetch: typeof globalThis.fetch,
  store: MemoryStore,
  issues: MemoryTracker,
  targets = [TARGET],
  extra: { inUse?: Set<string>; built?: Set<string>; now?: () => Date } = {},
) {
  return runVendorDocsWatch({ targets, fetch, store, issues, now: NOW, built: new Set(["demo"]), ...extra });
}

/** Serves each URL its own list of pages in turn. */
function sitesByUrl(pages: Record<string, (string | number)[]>) {
  const seen = new Map<string, number>();
  return (async (url: string | URL | Request) => {
    const key = String(url);
    const list = pages[key]!;
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    const next = list[Math.min(i, list.length - 1)]!;
    return typeof next === "number" ? new Response("gone", { status: next }) : new Response(next, { status: 200 });
  }) as typeof globalThis.fetch;
}

const tick = (body: string, vendor: string) => body.split("\n").map((l) => (l.endsWith(`<!-- row:${vendor} -->`) ? l.replace("- [ ] ", "- [x] ") : l)).join("\n");
const at = (iso: string) => () => new Date(iso);
const mockPage = (vendor: string, page: string, name = "Demo"): VendorDocsTarget => ({
  integration: `${vendor}:${page}`,
  name,
  url: `https://docs.${vendor}.example/${page}`,
  mock: { integration: vendor, retrievedOn: "2026-10-15" },
});

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

  it("puts a change on one watch issue: a ranked row in the body and the changed lines in a comment", async () => {
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
    expect(issue!.title).toBe("Vendor docs watch");
    expect(issue!.body.startsWith(WATCH_MARKER)).toBe(true);
    expect(issue!.body).toContain("**1 vendor waiting**");
    expect(issue!.body).toContain("- [ ] **Demo** (built): 1 page changed, seen 2026-10-11 <!-- row:demo -->");
    expect(issue!.body).toContain(`  - changed: ${TARGET.url} (changelog)`);
    // The issue is opened before its first comment, so that comment's link isn't in the row yet.
    expect(issue!.body).not.toContain("[evidence]");
    expect(issue!.comments).toHaveLength(1);
    const comment = issue!.comments[0]!;
    expect(comment).toMatch(/^Seen 2026-10-11T14:00:00.000Z\.\n\n### Demo\n\nThe Demo API changelog changed: https:\/\/docs.demo.example\/changelog\n/);
    expect(comment).toContain("+ Breaking: the orders.total field is removed in version 2027-01. Use orders.total_price.");
    expect(comment).toContain("- Rate limits stay at 40 requests per second.");
    expect(comment).toContain("+ Rate limits drop to 20 requests per second.");
    expect(store.snapshots.get("demo")!.sha256).toBe(sha256Hex(pageText(V2)));
  });

  it("adds each later change to the same issue, keeping the newest three evidence links", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const fetch = sitePages(V1, V2, V1, V2, V1, V2);
    for (let i = 0; i < 6; i++) await watch(fetch, store, issues, [TARGET], { now: at(`2026-10-${11 + i}T14:00:00Z`) });
    expect(issues.issues).toHaveLength(1);
    const [issue] = issues.issues;
    expect(issue!.comments).toHaveLength(5);
    expect(issue!.comments[4]).toMatch(/^Seen 2026-10-16T14:00:00.000Z\./);
    expect(issue!.body).toContain("- [ ] **Demo** (built): 1 page changed, first seen 2026-10-12, last 2026-10-16 <!-- row:demo -->");
    expect(issue!.body.split("\n")).toContain(
      `  - changed 5 times: ${TARGET.url} (changelog) [evidence](https://tracker.example/issues/1#c5) [2](https://tracker.example/issues/1#c4) [3](https://tracker.example/issues/1#c3)`,
    );
  });

  it("says 'seen' once for changes on the same day, and keeps the vendor's latest name", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const fetch = sitePages(V1, V2, V1);
    await watch(fetch, store, issues, [TARGET], { now: at("2026-10-11T08:00:00Z") });
    await watch(fetch, store, issues, [TARGET], { now: at("2026-10-11T09:00:00Z") });
    await watch(fetch, store, issues, [{ ...TARGET, name: "Demo Pay" }], { now: at("2026-10-11T20:00:00Z") });
    expect(issues.issues[0]!.body).toContain("- [ ] **Demo Pay** (built): 1 page changed, seen 2026-10-11 <!-- row:demo -->");
  });

  it("puts every page of one vendor on one row, and every page found in a run in one comment", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const a = mockPage("demo", "api-items");
    const b = mockPage("demo", "api-orders");
    const other = { integration: "other", name: "Other", url: "https://other.example/changelog" };
    const targets = [TARGET, a, b, other];
    const fetch = sitesByUrl({ [TARGET.url]: [V1, V2], [a.url]: [V1, V2], [b.url]: [V1, 404], [other.url]: [V1, V2] });
    await watch(fetch, store, issues, targets);
    const outcomes = await watch(fetch, store, issues, targets);
    expect(outcomes.map((o) => [o.integration, o.status, o.issue])).toEqual([
      ["demo", "changed", 1],
      ["demo:api-items", "changed", 1],
      ["demo:api-orders", "moved", 1],
      ["other", "changed", 1],
    ]);
    const [issue] = issues.issues;
    expect(issues.issues).toHaveLength(1);
    expect(issue!.body).toContain("**2 vendors waiting**");
    expect(issue!.body).toContain("- [ ] **Demo** (built): 2 pages changed, 1 moved, seen 2026-10-11 <!-- row:demo -->");
    expect(issue!.body).toContain("  - changed: https://docs.demo.example/api-items (doc mock page, read 2026-10-15)");
    expect(issue!.body).toContain("  - moved: https://docs.demo.example/api-orders (doc mock page, read 2026-10-15)");
    expect(issue!.body).toContain("- [ ] **Other** (not built yet): 1 page changed, seen 2026-10-11 <!-- row:other -->");
    expect(issue!.comments).toHaveLength(1);
    const comment = issue!.comments[0]!;
    expect(comment.match(/^### /gm)).toHaveLength(4);
    expect(comment).toContain("A page the Demo doc mock was built from changed: https://docs.demo.example/api-items. The mock matches the version read on 2026-10-15");
    expect(comment).toContain(
      "A page the Demo doc mock was built from, https://docs.demo.example/api-orders, answered HTTP 404 on 2026-10-11T14:00:00.000Z. Find where it moved and update `packages/testkit/src/mocks/demo.ts`.",
    );
  });

  it("ranks vendors a client uses first, then built ones, then the rest, newest first, without saying who uses what", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const t = (id: string, name: string) => ({ integration: id, name, url: `https://${id}.example/changelog` });
    const targets = [t("zeta", "Zeta"), t("alpha", "Alpha"), t("beta", "Beta"), t("gamma", "Gamma"), t("delta", "Delta")];
    const pages = Object.fromEntries(targets.map((x) => [x.url, [V1, V2, V1]]));
    const options = { inUse: new Set(["gamma"]), built: new Set(["beta", "gamma", "delta"]) };
    const fetch = sitesByUrl(pages);
    await watch(fetch, store, issues, targets, options);
    // Delta and Zeta change a day later than the others.
    await watch(fetch, store, issues, targets.slice(1, 4), options);
    await watch(fetch, store, issues, [targets[0]!, targets[4]!], { ...options, now: at("2026-10-12T14:00:00Z") });
    const body = issues.issues[0]!.body;
    const order = [...body.matchAll(/<!-- row:([a-z]+) -->/g)].map((m) => m[1]);
    expect(order).toEqual(["gamma", "delta", "beta", "zeta", "alpha"]);
    // Alpha was first seen earliest, but its newest change now puts it ahead of Zeta.
    await watch(fetch, store, issues, [targets[1]!], { ...options, now: at("2026-10-13T14:00:00Z") });
    expect([...issues.issues[0]!.body.matchAll(/<!-- row:([a-z]+) -->/g)].map((m) => m[1])).toEqual(["gamma", "delta", "beta", "alpha", "zeta"]);
    expect(body).toContain("**Gamma** (built)");
    expect(body).not.toMatch(/in use/i);
  });

  it("drops a ticked row on the next run, and brings it back when the page changes again", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const other = { integration: "other", name: "Other", url: "https://other.example/changelog" };
    const fetch = sitesByUrl({ [TARGET.url]: [V1, V2, V2, V1], [other.url]: [V1, V2, V2, V2] });
    await watch(fetch, store, issues, [TARGET, other]);
    await watch(fetch, store, issues, [TARGET, other]);
    const issue = issues.issues[0]!;
    issue.body = tick(issue.body, "demo");
    const updates = issues.updates;
    await watch(fetch, store, issues, [TARGET, other], { now: at("2026-10-12T14:00:00Z") });
    expect(issues.updates).toBe(updates + 1);
    expect(issue.body).not.toContain("row:demo");
    expect(issue.body).toContain("**1 vendor waiting**");
    expect(issue.body).toContain("row:other");
    expect(issue.comments).toHaveLength(1);
    // Nothing found and nothing ticked: the body isn't rewritten.
    await watch(sitesByUrl({ [TARGET.url]: [V2], [other.url]: [V2] }), store, issues, [TARGET, other], { now: at("2026-10-13T14:00:00Z") });
    expect(issues.updates).toBe(updates + 1);
    await watch(fetch, store, issues, [TARGET, other], { now: at("2026-10-14T14:00:00Z") });
    expect(issue.body).toContain("- [ ] **Demo** (built): 1 page changed, seen 2026-10-14 <!-- row:demo -->");
    expect(issue.body).toContain(`  - changed: ${TARGET.url} (changelog) [evidence](https://tracker.example/issues/1#c2)`);
  });

  it("says when nothing is waiting once every row is ticked", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    await watch(sitePages(V1, V2), store, issues);
    await watch(sitePages(V2), store, issues);
    issues.issues[0]!.body = tick(issues.issues[0]!.body, "demo");
    await watch(sitePages(V2), store, issues);
    expect(issues.issues[0]!.body).toContain("Nothing waiting.");
    expect(issues.issues[0]!.body).not.toContain("- [");
  });

  it("opens a new watch issue once the old one is closed", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const fetch = sitePages(V1, V2, V1);
    await watch(fetch, store, issues);
    await watch(fetch, store, issues);
    issues.issues[0]!.open = false;
    expect((await watch(fetch, store, issues))[0]).toMatchObject({ status: "changed", issue: 2 });
    expect(issues.issues[1]!.body).toContain("1 page changed");
  });

  it("fences page text so it can't break out of the evidence block", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    await watch(sitePages("<p>old</p>"), store, issues);
    await watch(sitePages("<p>````\n@everyone ``` </p>"), store, issues);
    expect(issues.issues[0]!.comments[0]).toContain("`````diff");
  });

  it("notes a change of only whitespace or order, and a diff too long to show", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const long = Array.from({ length: 50 }, (_, i) => `<p>line ${i}</p>`).join("");
    await watch(sitePages("<p>a</p><p>b</p>"), store, issues);
    await watch(sitePages("<p>b</p><p>a</p>"), store, issues);
    expect(issues.issues[0]!.comments[0]).toContain("(only whitespace or ordering changed)");
    await watch(sitePages(long), store, issues);
    expect(issues.issues[0]!.comments[1]).toContain("More lines changed than are shown here; open the page for the rest.");
  });

  it("re-baselines when the watched URL changes", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    await watch(sitePages(V1), store, issues);
    const moved = { ...TARGET, url: "https://docs.demo.example/v2/changelog" };
    expect(await watch(sitePages(V2), store, issues, [moved])).toEqual([{ integration: "demo", status: "baseline" }]);
    expect(issues.issues).toEqual([]);
  });

  it("files a 404 or 410 as moved, and nothing for transient failures", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    expect((await watch(sitePages(404), store, issues))[0]).toEqual({ integration: "demo", status: "moved", issue: 1, detail: "HTTP 404" });
    expect((await watch(sitePages(410), store, issues))[0]).toMatchObject({ status: "moved", issue: 1, detail: "HTTP 410" });
    expect(issues.issues).toHaveLength(1);
    expect(issues.issues[0]!.body).toContain("- [ ] **Demo** (built): 1 moved, seen 2026-10-11 <!-- row:demo -->");
    expect(issues.issues[0]!.comments[1]).toContain(
      "The Demo API changelog at https://docs.demo.example/changelog answered HTTP 410 on 2026-10-11T14:00:00.000Z. Find the new URL and update `changelog` for this integration in `packages/core/src/integrations.ts`.",
    );
    const comments = issues.issues[0]!.comments.length;
    expect((await watch(sitePages(503), store, issues))[0]).toEqual({ integration: "demo", status: "error", detail: "HTTP 503" });
    expect((await watch(sitePages(new Error("ECONNRESET")), store, issues))[0]).toEqual({
      integration: "demo",
      status: "error",
      detail: "ECONNRESET",
    });
    const proxied = new Error("fetch failed", { cause: new Error("Request was cancelled.", { cause: new Error("Proxy response (403)") }) });
    expect((await watch(sitePages(proxied), store, issues))[0]!.detail).toBe("fetch failed: Request was cancelled.: Proxy response (403)");
    expect(issues.issues).toHaveLength(1);
    expect(issues.issues[0]!.comments).toHaveLength(comments);
  });

  it("keeps the change unsaved when the watch issue can't be updated, and reports it again next run", async () => {
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
    expect(outcomes).toEqual([
      { integration: "demo", status: "error", detail: "changed, but the watch issue couldn't be updated: GitHub POST /issues answered 500" },
      { integration: "other", status: "error", detail: "changed, but the watch issue couldn't be updated: GitHub POST /issues answered 500" },
    ]);
    expect(store.snapshots.get("demo")!.sha256).toBe(sha256Hex(pageText(V1)));
    expect((await watch(sitePages(V2), store, issues, [TARGET]))[0]).toMatchObject({ status: "changed", issue: 1 });
  });

  it("leaves unchanged pages' results alone when the tracker is down", async () => {
    const store = new MemoryStore();
    const down = Object.assign(new MemoryTracker(), {
      findOpen: async () => {
        throw new Error("GitHub GET /issues answered 502");
      },
    });
    await watch(sitePages(V1), store, down);
    expect(await watch(sitePages(V1), store, down)).toEqual([{ integration: "demo", status: "unchanged" }]);
  });

  it("reports one target that throws as an error and checks the rest", async () => {
    const store = Object.assign(new MemoryStore(), {
      get: async (id: string) => {
        if (id === "demo") throw new Error("disk full");
        return null;
      },
    });
    const other = { integration: "other", name: "Other", url: "https://other.example/changelog" };
    expect(await watch(sitePages(V1), store, new MemoryTracker(), [TARGET, other])).toEqual([
      { integration: "demo", status: "error", detail: "disk full" },
      { integration: "other", status: "baseline" },
    ]);
  });

  it("ranks by the connector catalog when no built list is given", async () => {
    const store = new MemoryStore();
    const issues = new MemoryTracker();
    const shopify = { integration: "shopify", name: "Shopify", url: "https://shopify.example/changelog" };
    const fetch = sitesByUrl({ [shopify.url]: [V1, V2] });
    await runVendorDocsWatch({ targets: [shopify], fetch, store, issues, now: NOW });
    await runVendorDocsWatch({ targets: [shopify], fetch, store, issues, now: NOW });
    expect(issues.issues[0]!.body).toContain("**Shopify** (built)");
  });

  it("uses the real clock when none is given", async () => {
    const outcomes = await runVendorDocsWatch({ targets: [TARGET], fetch: sitePages(V1), store: new MemoryStore(), issues: new MemoryTracker() });
    expect(outcomes[0]!.status).toBe("baseline");
  });
});

describe("the watch issue's body", () => {
  const state = {
    demo: { name: "Demo", pages: { demo: { url: "https://demo.example", status: "changed" as const, firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-02T00:00:00Z", times: 1, evidence: [] } } },
  };

  it("round-trips its state without showing it as raw JSON", () => {
    const body = renderWatchBody(state, new Set(), new Set(), "2026-10-02T00:00:00Z");
    expect(readWatchBody(body)).toEqual(state);
    expect(body).not.toContain('"pages"');
    expect(body).toContain("**Demo** (not built yet): 1 page changed, first seen 2026-10-01, last 2026-10-02");
    expect(body).toContain("Updated 2026-10-02T00:00:00Z by the daily vendor docs watch.");
  });

  it("still reads a state saved as plain JSON", () => {
    expect(readWatchBody(`<!-- vendor-docs-state:${Buffer.from(JSON.stringify(state)).toString("base64")} -->`)).toEqual(state);
  });

  const many = (vendors: number, pages: number) =>
    Object.fromEntries(
      Array.from({ length: vendors }, (_, v) => [
        `v${v}`,
        {
          name: `Vendor ${v}`,
          pages: Object.fromEntries(
            Array.from({ length: pages }, (_, p) => [
              `v${v}:p${p}`,
              {
                url: `https://docs.v${v}.example/reference/a-long-page-name-for-endpoint-${p}`,
                status: "changed" as const,
                mock: "2026-10-15",
                firstSeen: "2026-10-01T00:00:00Z",
                lastSeen: `2026-10-${String(10 + (p % 20)).padStart(2, "0")}T00:00:00Z`,
                times: 2,
                evidence: [`https://tracker.example/issues/1#c${v}-${p}-1`, `https://tracker.example/issues/1#c${v}-${p}-2`],
              },
            ]),
          ),
        },
      ]),
    );

  it("lists a vendor's three newest pages and counts the rest", () => {
    const body = renderWatchBody(many(1, 5), new Set(), new Set(), "2026-10-30T00:00:00Z");
    const pages = body.split("\n").filter((l) => l.startsWith("  - "));
    expect(pages).toHaveLength(4);
    expect(pages[0]).toContain("endpoint-4 ");
    expect(pages[2]).toContain("endpoint-2 ");
    expect(pages[3]).toBe("  - and 2 more, in the comments");
    expect(readWatchBody(body)).toEqual(many(1, 5));
  });

  it("stays under GitHub's body limit: rows without pages, then the top rows with a count of the rest", () => {
    const bare = renderWatchBody(many(150, 3), new Set(), new Set(), "2026-10-30T00:00:00Z");
    expect(bare.length).toBeLessThanOrEqual(WATCH_BODY_LIMIT);
    expect(bare).not.toContain("\n  - ");
    expect(bare.match(/<!-- row:/g)).toHaveLength(150);
    expect(bare).not.toContain("more vendor");
    expect(WATCH_BODY_LIMIT).toBeLessThan(65_536);
    expect(readWatchBody(bare)).toEqual(many(150, 3));

    const cut = renderWatchBody(many(800, 1), new Set(), new Set(), "2026-10-30T00:00:00Z");
    expect(cut.length).toBeLessThanOrEqual(WATCH_BODY_LIMIT);
    const shown = cut.match(/<!-- row:/g)!.length;
    expect(shown).toBeGreaterThan(100);
    expect(shown).toBeLessThan(800);
    expect(cut).toContain(`- and ${800 - shown} more vendors, listed here as the ones above are ticked`);
    expect(Object.keys(readWatchBody(cut))).toHaveLength(800);
    expect(renderWatchBody(many(2, 1), new Set(), new Set(), "x")).not.toContain("more vendor");
  });

  it("says 'vendor' for one more", () => {
    // A single row bigger than the room left shows none of them.
    const huge = { big: { name: "x".repeat(WATCH_BODY_LIMIT), pages: { big: state.demo.pages.demo } } };
    expect(renderWatchBody(huge, new Set(), new Set(), "x")).toContain("- and 1 more vendor, listed here");
  });

  it("reads a body with no state, a broken state or a state that isn't an object as empty", () => {
    expect(readWatchBody(`${WATCH_MARKER}\nhand-written`)).toEqual({});
    expect(readWatchBody("<!-- vendor-docs-state:not base64 json -->")).toEqual({});
    expect(readWatchBody(`<!-- vendor-docs-state:${Buffer.from("[1]").toString("base64")} -->`)).toEqual({});
    expect(readWatchBody(`<!-- vendor-docs-state:${Buffer.from("null").toString("base64")} -->`)).toEqual({});
    for (const json of ["[1]", "null", "3"]) expect(readWatchBody(`<!-- vendor-docs-state:${deflateRawSync(Buffer.from(json)).toString("base64")} -->`)).toEqual({});
  });

  it("drops rows ticked with x or X, and only whole rows", () => {
    const body = renderWatchBody(state, new Set(), new Set(), "2026-10-02T00:00:00Z");
    expect(readWatchBody(body.replace("- [ ] **Demo**", "- [X] **Demo**"))).toEqual({});
    expect(readWatchBody(body.replace("- [ ] **Demo**", "  - [x] **Demo**"))).toEqual(state);
  });

  it("breaks ties by name, then id", () => {
    const page = state.demo.pages.demo;
    const tied = { b: { name: "Same", pages: { b: page } }, a: { name: "Same", pages: { a: page } }, c: { name: "Alpha", pages: { c: page } } };
    expect(rankVendors(tied, new Set(), new Set())).toEqual(["c", "a", "b"]);
  });

  it("files a doc mock page under the vendor it stands in for", () => {
    expect(vendorOf(mockPage("demo", "x"))).toBe("demo");
    expect(vendorOf(TARGET)).toBe("demo");
  });
});
