import { describe, expect, it } from "vitest";
import type { IssueTracker } from "../../packages/core/src/index.js";
import { INTEGRATIONS } from "../../packages/core/src/index.js";
import { connectedIds, renderSite } from "../build.js";
import { SITE_MARKER, checkSiteFreshness, compareSite, readSiteFacts } from "../freshness.js";

const page = (connected: string | null, mapped: string | null = "10") =>
  `<head>${connected === null ? "" : `<meta name="karatos-connected" content="${connected}">`}${mapped === null ? "" : `<meta name="karatos-mapped" content="${mapped}">`}</head>`;

function tracker(open: { number: number; body: string } | null = null) {
  const calls: string[] = [];
  const issues: IssueTracker = {
    findOpen: async (marker) => {
      calls.push(`find ${marker}`);
      return open;
    },
    open: async (title, body) => {
      calls.push(`open ${title}\n${body}`);
      return 42;
    },
    comment: async (n, body) => {
      calls.push(`comment ${n}\n${body}`);
    },
    close: async (n, body) => {
      calls.push(`close ${n} ${body}`);
    },
  };
  return { issues, calls };
}

const serving = (html: string, status = 200) => (async () => new Response(html, { status })) as typeof fetch;
const now = () => new Date("2026-10-28T12:00:00Z");
const URL = "https://site.example";

describe("readSiteFacts", () => {
  it("reads the connected ids and the mapped count", () => {
    expect(readSiteFacts(page("idex,shopify", "232"))).toEqual({ connected: ["idex", "shopify"], mapped: 232 });
  });

  it("returns nulls for a page deployed before the tags existed", () => {
    expect(readSiteFacts("<head><title>KaratOS</title></head>")).toEqual({ connected: null, mapped: null });
  });

  it("drops anything that is not a catalog-shaped id and rejects a bad count", () => {
    expect(readSiteFacts(page("shopify,,Bad Id,<x>,idex", "lots"))).toEqual({ connected: ["shopify", "idex"], mapped: null });
    expect(readSiteFacts(page("", "1234567")).mapped).toBeNull();
  });

  it("reads the tags from the real built page, matching the catalog", () => {
    const facts = readSiteFacts(renderSite());
    const built = INTEGRATIONS.filter((i) => i.status === "built").map((i) => i.id).sort();
    expect(facts.connected).toEqual(built);
    expect(facts.connected).toEqual(connectedIds());
    expect(facts.mapped).toBe(INTEGRATIONS.filter((i) => i.departments.length > 0).length);
  });
});

describe("compareSite", () => {
  const built = readSiteFacts(page("idex,nivoda,shopify", "12"));

  it("is fresh when the live page matches main", () => {
    expect(compareSite(readSiteFacts(page("idex,nivoda,shopify", "12")), built)).toEqual({ fresh: true, missing: [], extra: [], problems: [] });
  });

  it("names connectors main built that the live page lacks", () => {
    const result = compareSite(readSiteFacts(page("shopify", "12")), built);
    expect(result.fresh).toBe(false);
    expect(result.missing).toEqual(["idex", "nivoda"]);
    expect(result.problems).toEqual(["The live page is missing 2 connected systems that main has built."]);
  });

  it("names connectors on the live page that main no longer has, in the singular for one", () => {
    const result = compareSite(readSiteFacts(page("idex,nivoda,shopify,old_pos", "12")), built);
    expect(result.extra).toEqual(["old_pos"]);
    expect(result.problems).toEqual(["The live page shows 1 connected system that main no longer has."]);
  });

  it("flags a different mapped count even when the connectors match", () => {
    const result = compareSite(readSiteFacts(page("idex,nivoda,shopify", "9")), built);
    expect(result.fresh).toBe(false);
    expect(result.problems).toEqual(["The live page maps 9 systems; main maps 12."]);
    expect(compareSite(readSiteFacts(page("idex,nivoda,shopify", null)), built).problems).toEqual(["The live page maps an unknown number of systems; main maps 12."]);
  });

  it("treats a page without the tags as an old deploy missing everything", () => {
    const result = compareSite(readSiteFacts("<title>KaratOS</title>"), built);
    expect(result.fresh).toBe(false);
    expect(result.missing).toEqual(["idex", "nivoda", "shopify"]);
    expect(result.problems[0]).toMatch(/deployed before this check/);
  });

  it("throws when main's own page has no tags, so a broken build never reads as fresh", () => {
    expect(() => compareSite(built, readSiteFacts("<title>x</title>"))).toThrow(/built page/);
    expect(() => compareSite(built, readSiteFacts(page("a", null)))).toThrow(/built page/);
  });
});

describe("checkSiteFreshness", () => {
  const builtHtml = page("idex,shopify", "5");

  it("files nothing when the live page matches and nothing is open", async () => {
    const { issues, calls } = tracker();
    expect(await checkSiteFreshness({ url: URL, builtHtml, issues, fetch: serving(builtHtml), now })).toEqual({ status: "fresh", closed: null });
    expect(calls).toEqual([`find ${SITE_MARKER}`]);
  });

  it("closes the open issue once the live page catches up", async () => {
    const { issues, calls } = tracker({ number: 7, body: SITE_MARKER });
    expect(await checkSiteFreshness({ url: URL, builtHtml, issues, fetch: serving(builtHtml), now })).toEqual({ status: "fresh", closed: 7 });
    expect(calls[1]).toBe("close 7 The live page matches main again as of 2026-10-28T12:00:00.000Z. Closing; a new gap opens a new issue.");
  });

  it("opens one issue naming what is missing and how to fix the deploy", async () => {
    const { issues, calls } = tracker();
    const result = await checkSiteFreshness({ url: URL, builtHtml, issues, fetch: serving(page("shopify", "4")), now });
    expect(result).toEqual({ status: "stale", issue: 42, problems: ["The live page is missing 1 connected system that main has built.", "The live page maps 4 systems; main maps 5."] });
    const body = calls[1]!;
    expect(body.startsWith(`open The live website is behind main\n${SITE_MARKER}`)).toBe(true);
    expect(body).toContain("Missing from the live page: `idex`");
    expect(body).not.toContain("On the live page but not on main");
    expect(body).toContain("Open the website service on Railway");
    expect(body).toContain("checked 2026-10-28T12:00:00.000Z");
  });

  it("comments on the open issue instead of opening another, without repeating the marker", async () => {
    const { issues, calls } = tracker({ number: 9, body: SITE_MARKER });
    const result = await checkSiteFreshness({ url: URL, builtHtml, issues, fetch: serving(page("idex,shopify,gone", "5")), now });
    expect(result).toMatchObject({ status: "stale", issue: 9 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/^comment 9\nThe live website/);
    expect(calls[1]).toContain("On the live page but not on main: `gone`");
    expect(calls[1]).not.toContain(SITE_MARKER);
  });

  it("reports a site that answers with an error status as down", async () => {
    const { issues, calls } = tracker();
    const result = await checkSiteFreshness({ url: URL, builtHtml, issues, fetch: serving("bad gateway", 502), now });
    expect(result).toEqual({ status: "down", issue: 42, problems: ["The live page answered HTTP 502."] });
    expect(calls[1]).toMatch(/^open The website is not answering\n/);
  });

  it("reports a site that cannot be reached as down, keeping the error short", async () => {
    const { issues } = tracker();
    const failing = (async () => {
      throw new Error(`getaddrinfo ENOTFOUND ${"x".repeat(400)}`);
    }) as typeof fetch;
    const result = await checkSiteFreshness({ url: URL, builtHtml, issues, fetch: failing, now });
    expect(result.status).toBe("down");
    if (result.status === "fresh") throw new Error("expected down");
    expect(result.problems[0]!.length).toBeLessThan(260);
    expect(result.problems[0]).toMatch(/^The live page could not be reached: getaddrinfo ENOTFOUND/);
  });

  it("rejects a broken build of main before touching any issue", async () => {
    const { issues, calls } = tracker();
    await expect(checkSiteFreshness({ url: URL, builtHtml: "<title>x</title>", issues, fetch: serving(builtHtml), now })).rejects.toThrow(/built page/);
    expect(calls).toEqual([]);
  });

  it("asks for HTML and follows redirects", async () => {
    const { issues } = tracker();
    let seen: RequestInit | undefined;
    const fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(builtHtml);
    }) as typeof globalThis.fetch;
    await checkSiteFreshness({ url: URL, builtHtml, issues, fetch, now });
    expect(seen).toMatchObject({ headers: { accept: "text/html" }, redirect: "follow" });
  });
});
