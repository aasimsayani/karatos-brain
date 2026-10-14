import { describe, expect, it } from "vitest";
import { INTEGRATIONS, selfServeIntegrations } from "../../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../../packages/retail/src/index.js";
import { CONSOLE_PRICE, CONTACT_ANCHOR, FONTS_URL, REPORT_URL, buildingNow, escapeHtml, renderSite } from "../build.js";

const html = renderSite();

describe("KaratOS website", () => {
  it("lists every data integration from the catalog", () => {
    const missing = INTEGRATIONS.filter((i) => i.departments.length > 0 && !html.includes(`<h3>${escapeHtml(i.name)}</h3>`)).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it("marks exactly the self-serve integrations that are not deferred as being built now", () => {
    const building = buildingNow();
    expect(building.length).toBe(selfServeIntegrations().filter((i) => i.status !== "deferred").length);
    expect(html.match(/pill gold">Building now/g)?.length).toBe(building.length);
    expect(html).toContain(`<strong>${building.length}</strong><span>building now</span>`);
  });

  it("shows every retail department and its purpose", () => {
    for (const department of RETAIL_DEPARTMENTS) expect(html).toContain(escapeHtml(department.purpose));
  });

  it("links the broken-systems campaign to the integration request form", () => {
    expect(html).toContain(`href="${REPORT_URL}"`);
    expect(REPORT_URL).toContain("template=integration-request.yml");
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

  it("offers the Brain Console at its list price and the other services by quote", () => {
    expect(html).toContain(`<strong>${CONSOLE_PRICE}</strong> per user per month`);
    expect(html.match(/<strong>By quote<\/strong>/g)?.length).toBe(2);
    expect(html.split(`href="${CONTACT_ANCHOR}"`).length - 1).toBe(3);
    // The console price covers dashboard access only; setup is a quoted service.
    expect(html).toContain("Setting up the instance and connecting your systems isn't included");
  });

  it("leads the header with Custom services instead of a GitHub button", () => {
    const header = html.slice(html.indexOf('<header class="nav">'), html.indexOf("</header>"));
    expect(header).toContain('href="#services">Custom services</a>');
    expect(header).not.toContain("GitHub");
  });

  it("sends quote requests to the private form, with each plan's interest preselected", () => {
    expect(html).toContain('<form id="inquiry"');
    for (const interest of ["brain_console", "maintenance", "custom_services"]) {
      expect(html).toContain(`data-interest="${interest}"`);
      expect(html).toContain(`name="interests" value="${interest}"`);
    }
    expect(html).toContain("fetch('/api/inquiry'");
    expect(html).not.toContain("custom-services.yml");
  });
});
