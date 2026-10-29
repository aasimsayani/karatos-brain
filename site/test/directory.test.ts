import { describe, expect, it } from "vitest";
import { INTEGRATIONS, type IntegrationSpec } from "../../packages/core/src/index.js";
import { CONNECTED_ON, SYSTEM_DETAILS } from "../directory.js";
import { DOMAIN_LABELS, SITE_URL, directoryCategories, escapeHtml, formatDay, newestConnections, renderCard, renderDirectory, renderSite, systemDetail } from "../build.js";

const html = renderSite();
const dataSources = INTEGRATIONS.filter((i) => i.departments.length > 0);
const built = INTEGRATIONS.filter((i) => i.status === "built");
const section = (id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};
const spec = (over: Partial<IntegrationSpec>): IntegrationSpec => ({
  id: "shopify",
  name: "Shop <one>",
  domain: "ecommerce",
  segments: ["retail"],
  access: "public_api",
  testWith: "sandbox",
  departments: ["sales"],
  historicalImportYears: 5,
  webhooks: true,
  settings: [],
  changelog: null,
  status: "planned",
  ...over,
});

describe("system details", () => {
  it("has a detail line for exactly the systems on the map, so a new catalog entry needs one", () => {
    expect(Object.keys(SYSTEM_DETAILS).sort()).toEqual(dataSources.map((i) => i.id).sort());
  });

  it("keeps every detail line one plain sentence an owner can read", () => {
    for (const [id, d] of Object.entries(SYSTEM_DETAILS)) {
      expect(d.about, id).toMatch(/^(?:[A-Z0-9]|eBay|iMessage).{10,140}\.$/);
      expect(d.about, id).not.toMatch(/\b(API|OAuth|scope|webhook|endpoint|GET)\b/);
      if (d.company !== undefined) expect(d.company, id).toMatch(/^[A-Z][A-Za-z0-9 ]{1,30}$/);
    }
  });

  it("names a company only when it makes more than one system on the map, or it is a household name", () => {
    const counts = new Map<string, number>();
    for (const d of Object.values(SYSTEM_DETAILS)) if (d.company) counts.set(d.company, (counts.get(d.company) ?? 0) + 1);
    expect(counts.get("Google")).toBe(6);
    expect(counts.get("Microsoft")).toBe(3);
    expect(counts.get("Meta")).toBe(2);
    expect(counts.get("Jewelers Mutual")).toBe(4);
  });

  it("dates exactly the built connectors, with real days", () => {
    expect(Object.keys(CONNECTED_ON).sort()).toEqual(built.map((i) => i.id).sort());
    for (const [id, day] of Object.entries(CONNECTED_ON)) expect(Number.isNaN(Date.parse(`${day}T00:00:00Z`)), id).toBe(false);
  });

  it("throws for a system with no detail line", () => {
    expect(() => systemDetail("not_a_system")).toThrow(/site\/directory.ts/);
  });

  it("formats days for the page and rejects anything else", () => {
    expect(formatDay("2026-10-28")).toBe("Oct 28, 2026");
    expect(formatDay("2027-01-03")).toBe("Jan 3, 2027");
    expect(() => formatDay("Oct 28")).toThrow(/YYYY-MM-DD/);
  });
});

describe("the directory, grouped by category", () => {
  const directory = section("integrations");

  it("shows every system once, in a group for its category", () => {
    for (const i of dataSources) {
      const group = directory.slice(directory.indexOf(`data-group="${i.domain}"`));
      const end = group.indexOf('<details class="group"', 1);
      expect((end < 0 ? group : group.slice(0, end)).includes(`<h3>${escapeHtml(i.name)}</h3>`), i.id).toBe(true);
    }
    expect(directory.match(/<li class="card"/g)).toHaveLength(dataSources.length);
  });

  it("has one group per category, each labelled and counted, and marketing is one of them", () => {
    const categories = directoryCategories(dataSources);
    expect(new Set(categories)).toEqual(new Set(dataSources.map((i) => i.domain)));
    expect(directory.match(/<details class="group"/g)).toHaveLength(categories.length);
    const marketing = dataSources.filter((i) => i.domain === "marketing");
    expect(marketing.length).toBeGreaterThan(10);
    expect(directory).toContain(`<h3>${DOMAIN_LABELS.marketing}</h3><span class="count">${marketing.length} systems · ${marketing.filter((i) => i.status === "built").length} connected</span>`);
    for (const d of categories) {
      expect(directory).toContain(`<option value="${d}">`);
      expect(directory).toContain(`<a href="#cat-${d}">`);
    }
  });

  it("puts the categories with the most connected systems first", () => {
    const order = directoryCategories(dataSources);
    const builtIn = (d: string) => dataSources.filter((i) => i.domain === d && i.status === "built").length;
    for (let n = 1; n < order.length; n++) expect(builtIn(order[n - 1]!)).toBeGreaterThanOrEqual(builtIn(order[n]!));
  });

  it("gives every card its detail line and a details panel", () => {
    expect(directory.match(/<details class="more">/g)).toHaveLength(dataSources.length);
    for (const i of dataSources) expect(directory, i.id).toContain(`<p class="about">${escapeHtml(SYSTEM_DETAILS[i.id]!.about)}</p>`);
  });

  it("lists connected systems first within a group", () => {
    const groups = directory.split('<details class="group"').slice(1);
    for (const g of groups) {
      const pills = [...g.matchAll(/pill (?:gold|plain|muted)">([^<]+)</g)].map((m) => m[1] === "Connector built");
      expect(pills.indexOf(false) < 0 || pills.lastIndexOf(true) < pills.indexOf(false)).toBe(true);
    }
  });

  it("filters by category as well as text, business and department, and hides empty groups", () => {
    const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    expect(script).toContain("c.dataset.domain===k");
    expect(script).toContain("g.hidden=inGroup===0");
    // A filter opens the groups it matches, and a category link opens its group.
    expect(script).toContain("if(filtering&&inGroup) g.open=true;");
    expect(script).toContain("g.open=true;g.scrollIntoView()");
    expect(html).toContain('<select id="category" aria-label="Category">');
  });
});

describe("renderCard", () => {
  const dept = new Map([["sales", "Sales <floor>"]]);

  it("shows the company, the detail line and every detail row, escaped", () => {
    const card = renderCard(spec({ id: "gmail", name: "Mail <x>" }), new Set(), dept);
    expect(card).toContain('<span class="domain">By Google</span>');
    expect(card).toContain("<h3>Mail &lt;x&gt;</h3>");
    for (const k of ["What KaratOS reads", "How it connects", "History", "Updates", "Tested", "Feeds", "For", "Stage"]) expect(card).toContain(`<dt>${k}</dt>`);
    expect(card).toContain("<dd>Up to 5 years imported on day one</dd>");
    expect(card).toContain("<dd>As they happen, through the vendor&#39;s webhooks</dd>");
    expect(card).toContain("<dd>Sales &lt;floor&gt;</dd>");
    expect(card).toContain('data-domain="ecommerce"');
    expect(card).toContain("connected");
    expect(card).toContain("<dt>Connected</dt><dd>Oct 28, 2026</dd>");
  });

  it("falls back to the category label without a company, and words one year, no history and scheduled updates", () => {
    const one = renderCard(spec({ id: "arms", historicalImportYears: 1, webhooks: false }), new Set(), dept);
    expect(one).toContain('<span class="domain">E-commerce</span>');
    expect(one).toContain("<dd>Up to 1 year imported on day one</dd>");
    expect(one).toContain("<dd>On a regular schedule</dd>");
    expect(one).not.toContain("<dt>Connected</dt>");
    expect(renderCard(spec({ id: "arms", historicalImportYears: 0 }), new Set(), dept)).toContain("<dd>From the day it is connected</dd>");
  });

  it("explains the stage the system is at", () => {
    expect(renderCard(spec({ id: "arms" }), new Set(["arms"]), dept)).toContain("<dt>Stage</dt><dd>Being built now.");
    expect(renderCard(spec({ id: "arms" }), new Set(), dept)).toContain("<dt>Stage</dt><dd>On the map.");
    expect(renderCard(spec({ id: "arms", status: "deferred" }), new Set(), dept)).toContain("<dt>Stage</dt><dd>On hold");
    expect(renderCard(spec({ id: "arms", status: "built", capabilities: ["Sees <it>."] }), new Set(), dept)).toContain("<li>Sees &lt;it&gt;.</li>");
  });

  it("puts the company and detail line in the search text", () => {
    const card = renderCard(spec({ id: "google_ads", name: "Ads" }), new Set(), dept);
    expect(card).toMatch(/data-search="ads google search and shopping ad spend/);
  });

  it("stops on a system without a detail line rather than rendering a blank card", () => {
    expect(() => renderDirectory([spec({ id: "nope" })], new Set(), dept)).toThrow(/nope/);
  });
});

describe("newest connections", () => {
  it("shows the most recently connected systems, newest first", () => {
    const newest = newestConnections();
    expect(newest).toHaveLength(8);
    const days = newest.map((i) => CONNECTED_ON[i.id]!);
    expect([...days].sort().reverse()).toEqual(days);
    const latest = Object.values(CONNECTED_ON).sort().at(-1)!;
    expect(days[0]).toBe(latest);
    const strip = html.slice(html.indexOf('<div class="newest">'), html.indexOf("</div>", html.indexOf('<div class="newest">')));
    for (const i of newest) expect(strip).toContain(`<strong>${escapeHtml(i.name)}</strong>`);
    expect(strip).toContain(formatDay(latest));
  });

  it("returns fewer when asked", () => {
    expect(newestConnections(3)).toHaveLength(3);
  });
});

describe("the partner section and the hero's proof", () => {
  it("shows how many systems sit at each stage, adding up to the map", () => {
    const partners = section("partners");
    const counts = [...partners.matchAll(/<li><strong>(\d+)<\/strong><h3>/g)].map((m) => Number(m[1]));
    expect(counts).toHaveLength(3);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(dataSources.length);
    expect(counts[2]).toBe(built.length);
    expect(partners).toContain("Read-only by default");
    expect(html).toContain('<a href="#partners">Partners</a>');
  });

  it("leads the hero with what is connected and mapped today", () => {
    const proof = html.slice(html.indexOf('<ul class="proof"'), html.indexOf("</ul>", html.indexOf('<ul class="proof"')));
    expect(proof).toContain(`<strong>${built.length}</strong><span>systems connected</span>`);
    expect(proof).toContain(`<strong>${dataSources.length}</strong><span>systems mapped</span>`);
    expect(proof).toContain(`<strong>${directoryCategories(dataSources).length}</strong>`);
  });
});

describe("sharing and search", () => {
  it("names karatos.app as the page's home and gives link previews a title and description", () => {
    expect(SITE_URL).toBe("https://karatos.app/");
    expect(html).toContain('<link rel="canonical" href="https://karatos.app/">');
    expect(html).toContain('<meta property="og:url" content="https://karatos.app/">');
    expect(html).toContain('<meta property="og:title" content="KaratOS: the operating brain for jewelry businesses">');
    const description = /<meta name="description" content="([^"]+)">/.exec(html)![1];
    expect(html).toContain(`<meta property="og:description" content="${description}">`);
  });
});
