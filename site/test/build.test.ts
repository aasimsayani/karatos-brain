import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server.js";
import { INTEGRATIONS, selfServeIntegrations } from "../../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../../packages/retail/src/index.js";
import { CONTACT_ANCHOR, CORE_PRICE, FONTS, MANAGED_PRICE, REPORT_URL, buildingNow, earlyAccessNote, escapeHtml, renderSite } from "../build.js";

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

  it("sets type in self-hosted IBM Plex, with no third-party font requests", () => {
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|rel="stylesheet"/);
    expect(html).not.toMatch(/Fraunces|Inter,/);
    for (const f of FONTS) {
      expect(html).toContain(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/fonts/${f.file}) format('woff2')}`);
      expect(html.includes(`<link rel="preload" href="/fonts/${f.file}" as="font" type="font/woff2" crossorigin>`)).toBe(f.preload);
    }
    // The first screen's body and heading weights; preloading more would delay the first paint.
    expect([...html.matchAll(/rel="preload" href="\/fonts\/([^"]+)"/g)].map((m) => m[1])).toEqual(["plex-sans-400.woff2", "plex-sans-600.woff2"]);
    // Every weight the page asks for has a face, so no browser fakes a bold.
    const weights = new Set([...html.matchAll(/font-weight:(\d{3})/g)].map((m) => Number(m[1])));
    const sansWeights = new Set(FONTS.filter((f) => f.family === "IBM Plex Sans").map((f) => f.weight));
    expect([...weights].filter((w) => !sansWeights.has(w as 400))).toEqual([]);
    const body = html.slice(html.indexOf("body{margin:0"), html.indexOf("}", html.indexOf("body{margin:0")));
    expect(body).toContain("font:17px/1.6 var(--sans)");
    expect(html).toContain("--sans:'IBM Plex Sans',system-ui");
    expect(html).toContain("--mono:'IBM Plex Mono',ui-monospace");
  });

  it("spaces the page on one 8px scale, with every section and the hero padded the same", () => {
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).toContain("--space-1:8px;--space-2:16px;--space-3:24px;--space-4:32px;--space-5:48px;--section:clamp(64px,9vw,96px);");
    expect(css).toContain(".hero{padding-top:var(--section);padding-bottom:var(--section)}");
    expect(css).toContain("section{padding:var(--section) 0;");
    expect(css).toContain("footer{padding:var(--space-5) 0;");
    // Heading, intro and content keep the same rhythm in every section.
    expect(css).toContain(".section-intro{color:var(--ink-2);max-width:62ch;margin:var(--space-2) 0 var(--space-5);");
    expect(css).toContain("margin-bottom:var(--space-2);line-height:1.4}");
    // Any spacing written in pixels stays on a 4px grid, so nothing sits a few pixels off.
    const offGrid = [...css.matchAll(/(?:^|[;{])((?:padding|margin|gap)(?:-[a-z]+)?):([^;}]+)/g)]
      .flatMap((m) => [...m[2]!.matchAll(/(\d+)px/g)].map((n) => ({ rule: `${m[1]}:${m[2]}`, px: Number(n[1]) })))
      .filter((v) => v.px % 4 !== 0)
      .map((v) => v.rule);
    expect(offGrid).toEqual([]);
  });

  it("lines up the plans' fine print and buttons across cards", () => {
    expect(html).toContain(".plan .price+p{flex:1}");
    expect(html).toContain(".plan .btn{margin-top:var(--space-2);align-self:flex-start}");
  });

  it("keeps the hero inside the page gutter on phones", () => {
    // The hero shares an element with .wrap; a padding shorthand there would zero the side gutter.
    expect(html).toContain('<div class="wrap hero">');
    expect(html).not.toMatch(/\.hero\{padding:/);
  });

  it("leaves off-screen sections unrendered until they near the viewport, so the growing catalog doesn't block the first paint", () => {
    expect(html).toContain("section{content-visibility:auto;contain-intrinsic-size:auto 900px}");
    // The hero is not a section, so the first screen always renders straight away.
    expect(html).not.toMatch(/<section[^>]*class="[^"]*hero/);
  });

  it("only uses Mono at a weight it ships", () => {
    const monoWeights = FONTS.filter((f) => f.family === "IBM Plex Mono").map((f) => `font-weight:${f.weight}`);
    const rules = html.match(/[^{}]+\{[^{}]*font-family:var\(--mono\)[^{}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(4);
    for (const rule of rules) {
      const w = rule.match(/font-weight:\d{3}/)?.[0];
      if (w) expect(monoWeights, rule).toContain(w);
    }
  });

  it("keeps small gold and grey text at WCAG AA contrast", () => {
    expect(html).toContain("--muted:#6b665b");
    expect(html).toContain("--gold-text:#82632a");
    for (const rule of [".eyebrow{", ".example .tag{", ".pill.gold{"]) {
      const css = html.slice(html.indexOf(rule), html.indexOf("}", html.indexOf(rule)));
      expect(css).toContain("color:var(--gold-text)");
    }
  });

  it("runs under the strict content policy: one inline script and style, no inline handlers or style attributes", () => {
    // Any casing or attributes count: exactly one bare <script> and one bare <style>, nothing else.
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(["<script>"]);
    expect(html.match(/<style\b[^>]*>/gi)).toEqual(["<style>"]);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    const csp = contentSecurityPolicy(html);
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'$|script-src 'self' 'sha256-[A-Za-z0-9+/]+=*';/);
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
