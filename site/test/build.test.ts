import { describe, expect, it } from "vitest";
import { INTEGRATIONS, selfServeIntegrations } from "../../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../../packages/retail/src/index.js";
import { CONTACT_ANCHOR, CORE_PRICE, FONTS_URL, MANAGED_PRICE, REPORT_URL, buildingNow, earlyAccessNote, escapeHtml, renderSite } from "../build.js";

const html = renderSite();

describe("KaratOS website", () => {
  it("lists every data integration from the catalog", () => {
    const missing = INTEGRATIONS.filter((i) => i.departments.length > 0 && !html.includes(`<h3>${escapeHtml(i.name)}</h3>`)).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it("marks built connectors, and exactly the planned self-serve integrations as being built now", () => {
    const building = buildingNow();
    expect(building.length).toBe(selfServeIntegrations().filter((i) => i.status === "planned").length);
    const built = INTEGRATIONS.filter((i) => i.status === "built");
    expect(built.map((i) => i.id)).toContain("shopify");
    expect(html.match(/pill gold">Connector built/g)?.length).toBe(built.length);
    // Built connectors lead the directory.
    expect(html.indexOf(escapeHtml(built[0]!.name))).toBeLessThan(html.indexOf(escapeHtml(building[0]!.name)));
    expect(html.match(/pill gold">Building now/g)?.length).toBe(building.length);
    expect(html).toContain(`<strong>${building.length}</strong><span>building now</span>`);
  });

  it("explains what each built connector gives the business, and names them in the hero", () => {
    const built = INTEGRATIONS.filter((i) => i.status === "built");
    for (const integration of built) {
      const list = `<ul class="caps" aria-label="What you get with ${escapeHtml(integration.name)}">`;
      expect(html).toContain(list);
      for (const capability of integration.capabilities ?? []) expect(html).toContain(`<li>${escapeHtml(capability)}</li>`);
      expect(earlyAccessNote()).toContain(integration.name);
    }
    expect(html.match(/<ul class="caps"/g)?.length).toBe(built.length);
    expect(html).toContain(`<p class="note">${escapeHtml(earlyAccessNote())}</p>`);
  });

  it("shows every retail department and its purpose", () => {
    for (const department of RETAIL_DEPARTMENTS) expect(html).toContain(escapeHtml(department.purpose));
  });

  it("sends broken-system reports to the private form first, with the public form as the alternative", () => {
    const campaign = html.slice(html.indexOf('<section id="broken"'), html.indexOf("</section>", html.indexOf('<section id="broken"')));
    expect(campaign).toContain(`href="${CONTACT_ANCHOR}" data-interest="broken_system">Tell us privately</a>`);
    expect(campaign).toContain(`href="${REPORT_URL}"`);
    expect(campaign).not.toContain("on the way");
    expect(REPORT_URL).toContain("template=integration-request.yml");
    expect(html).toContain('name="interests" value="broken_system"');
    expect(html).toContain('<input name="system" maxlength="160"');
    expect(html).toContain("'seats','system','message'");
  });

  it("loads web fonts without blocking the first paint", () => {
    expect(html).toContain(`<link href="${FONTS_URL}" rel="stylesheet" media="print" onload="this.media='all'">`);
    expect(html).toContain(`<noscript><link href="${FONTS_URL}" rel="stylesheet"></noscript>`);
    expect(html.match(/rel="stylesheet"/g)).toHaveLength(2);
  });

  it("keeps small gold and grey text at WCAG AA contrast", () => {
    expect(html).toContain("--muted:#6b665b");
    expect(html).toContain("--gold-text:#82632a");
    for (const rule of [".eyebrow{", ".example .tag{", ".pill.gold{"]) {
      const css = html.slice(html.indexOf(rule), html.indexOf("}", html.indexOf(rule)));
      expect(css).toContain("color:var(--gold-text)");
    }
  });

  it("names no client", () => {
    expect(html.toLowerCase()).not.toContain("fuse");
  });

  it("escapes text taken from the catalog", () => {
    expect(escapeHtml(`<a href="x">Tom's & co</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;");
  });

  it("prices Core and Managed per store and quotes multi-store and custom work", () => {
    expect(html).toContain(`<strong>${CORE_PRICE}</strong> per store per month`);
    expect(html).toContain(`<strong>${MANAGED_PRICE}</strong> per store per month`);
    expect(html).not.toContain("per user per month");
    expect(html.match(/<strong>By quote<\/strong>/g)?.length).toBe(1);
    // Three plans plus the broken-systems campaign.
    expect(html.split(`href="${CONTACT_ANCHOR}"`).length - 1).toBe(4);
    // Managed is the featured plan.
    const featured = html.slice(html.indexOf('<li class="plan featured">'));
    expect(featured.slice(0, featured.indexOf("</li>"))).toContain("<h3>Managed</h3>");
  });

  it("leads the header with Custom services instead of a GitHub button", () => {
    const header = html.slice(html.indexOf('<header class="nav">'), html.indexOf("</header>"));
    expect(header).toContain('href="#services">Custom services</a>');
    expect(header).not.toContain("GitHub");
  });

  it("sends quote requests to the private form, with each plan's interest preselected", () => {
    expect(html).toContain('<form id="inquiry"');
    for (const interest of ["brain_console", "maintenance", "custom_services", "broken_system"]) {
      expect(html).toContain(`data-interest="${interest}"`);
      expect(html).toContain(`name="interests" value="${interest}"`);
    }
    expect(html).toContain("fetch('/api/inquiry'");
    expect(html).not.toContain("custom-services.yml");
  });
});
