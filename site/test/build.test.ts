import { describe, expect, it } from "vitest";
import { INTEGRATIONS, selfServeIntegrations } from "../../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../../packages/retail/src/index.js";
import { REPORT_URL, buildingNow, escapeHtml, renderSite } from "../build.js";

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

  it("names no client", () => {
    expect(html.toLowerCase()).not.toContain("fuse");
  });

  it("escapes text taken from the catalog", () => {
    expect(escapeHtml(`<a href="x">Tom's & co</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;");
  });
});
