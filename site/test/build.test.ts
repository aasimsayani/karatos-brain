import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server.js";
import { INTEGRATIONS, selfServeIntegrations } from "../../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../../packages/retail/src/index.js";
import { CONTACT_ANCHOR, CORE_PRICE, DOMAIN_LABELS, FONTS, MANAGED_PRICE, PLAYS, REPORT_URL, WRITE_RULES, buildingNow, domainLabel, earlyAccessNote, escapeHtml, renderSite } from "../build.js";

const html = renderSite();
const sectionOf = (id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};

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

  it("shows systems working together: 4 to 6 illustrative plays, each combining 3 or 4 catalog systems into one result", () => {
    const together = sectionOf("together");
    expect(together).toContain('<span class="eyebrow">Systems that work together</span>');
    expect(together).toContain("<h2>One system knows a little. Together they know what to do.</h2>");
    expect(PLAYS.length).toBeGreaterThanOrEqual(4);
    expect(PLAYS.length).toBeLessThanOrEqual(6);
    const cards = together.split('<li class="play">').slice(1);
    expect(cards).toHaveLength(PLAYS.length);
    const byId = new Map(INTEGRATIONS.map((i) => [i.id, i]));
    PLAYS.forEach((play, n) => {
      const card = cards[n]!;
      expect(card).toContain('<span class="tag">Illustrative</span>');
      expect(card).toContain(`<h3>${escapeHtml(play.title)}</h3>`);
      expect(play.systems.length).toBeGreaterThanOrEqual(3);
      expect(play.systems.length).toBeLessThanOrEqual(4);
      expect(new Set(play.systems).size).toBe(play.systems.length);
      const named = [...card.matchAll(/<ul class="play-systems"[^>]*>(.*?)<\/ul>/g)][0]![1]!;
      expect(named).toBe(play.systems.map((id) => `<li>${escapeHtml(byId.get(id)!.name)}</li>`).join(""));
      expect(card.match(/<p class="play-action">/g)).toHaveLength(1);
      expect(card).toContain(`<strong>Result:</strong> ${escapeHtml(play.action)}`);
    });
    expect(together.match(/<span class="tag">Illustrative<\/span>/g)).toHaveLength(PLAYS.length);
  });

  it("names only systems that are in the integrations catalog", () => {
    const ids = new Set(INTEGRATIONS.map((i) => i.id));
    expect(PLAYS.flatMap((p) => p.systems).filter((id) => !ids.has(id))).toEqual([]);
    // The build stops rather than publish a play naming a system we don't have.
    expect(() => renderSite([{ title: "Made up", systems: ["shopify", "not_a_system", "stripe"], action: "Nothing." }])).toThrow(/not_a_system/);
  });

  it("explains careful write-back in plain language, with every safeguard named", () => {
    const writeBack = sectionOf("write-back");
    expect(writeBack).toContain("<h2>Reads freely. Writes carefully.</h2>");
    const text = writeBack.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
    for (const claim of [
      "Every connection starts read-only",
      "Writing back is off until your business turns it on, per system and per action",
      "prefers a draft or a new note over changing a record",
      "it never deletes",
      "A person approves each write",
      "re-checks the record right before writing",
      "Capped per day",
      "reads the record back to confirm it landed",
      "Every write can be undone",
      "all writes to that system stop until a person checks",
      "Your systems stay the source of truth",
      "rather than becoming another database to pay for",
    ]) expect(text, claim).toContain(claim);
    expect(writeBack.match(/<li><h3>/g)).toHaveLength(WRITE_RULES.length);
    expect(text.toLowerCase()).not.toMatch(/refuse|delete records|deletes records/);
  });

  it("points the hero, steps and nav at many connected systems and careful write-back", () => {
    const hero = html.slice(html.indexOf('<div class="wrap hero">'), html.indexOf("</div>", html.indexOf('<div class="wrap hero">')));
    expect(hero).toContain("For jewelers, watch dealers, wholesalers and manufacturers");
    expect(hero).toContain("connects the many systems");
    expect(hero).toContain("writes back carefully");
    const how = sectionOf("how");
    const mapped = INTEGRATIONS.filter((i) => i.departments.length > 0).length;
    expect(how).toContain(`from ${mapped} systems on our map`);
    expect(how).toContain("<h3>Connect everything, read-only</h3>");
    expect(how).toContain("<h3>Act, and write back carefully</h3>");
    const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
    expect(nav).toContain('<a href="#together">Systems together</a>');
    expect(nav).toContain('<a href="#write-back">Write-back</a>');
    // Every nav link lands on a section that exists.
    for (const [, id] of nav.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
  });

  it("labels every catalog domain in plain language", () => {
    for (const integration of INTEGRATIONS) expect(DOMAIN_LABELS[integration.domain], integration.domain).toBeTruthy();
    expect(domainLabel("pos")).toBe("Point of sale");
    expect(domainLabel("future")).toBe("Future");
  });

  it("serves the page under exactly the strict policy, with the inline script and style allowed only by hash", () => {
    const hash = (tag: string) => {
      const m = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))!;
      return `'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`;
    };
    expect(contentSecurityPolicy(html)).toBe(
      [
        "default-src 'none'",
        `script-src 'self' ${hash("script")}`,
        `style-src 'self' ${hash("style")}`,
        "font-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    // No external scripts, styles, images or frames: the page loads only from itself.
    expect(html).not.toMatch(/<(script|img|iframe)\b[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link\b[^>]*href="https?:/i);
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
