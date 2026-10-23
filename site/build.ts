/**
 * Builds the KaratOS website into site/dist. The integration directory and
 * department list come straight from the code, so the site never drifts from
 * what the engine actually supports.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { INTEGRATIONS, selfServeIntegrations, type IntegrationSpec } from "../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../packages/retail/src/index.js";

export const REPORT_URL =
  "https://github.com/aasimsayani/karatos-brain/issues/new?template=integration-request.yml";
export const REPO_URL = "https://github.com/aasimsayani/karatos-brain";
/** Quote and Brain Console requests go to the private form on the page. */
export const CONTACT_ANCHOR = "#contact";
export const CORE_PRICE = "$299";
export const MANAGED_PRICE = "$599";
/**
 * IBM Plex, served from the site itself: IBM drew it as a nod to its own
 * early typewriter and terminal faces. Sans carries the words, Mono the
 * labels and figures. Self-hosting means no third-party request and no late
 * swap from a different font. Latin subset only; OFL-licensed (@fontsource).
 */
export const FONTS = [
  { file: "plex-sans-400.woff2", pkg: "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2", family: "IBM Plex Sans", weight: 400, preload: true },
  { file: "plex-sans-500.woff2", pkg: "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2", family: "IBM Plex Sans", weight: 500, preload: false },
  { file: "plex-sans-600.woff2", pkg: "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2", family: "IBM Plex Sans", weight: 600, preload: true },
  { file: "plex-mono-500.woff2", pkg: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", family: "IBM Plex Mono", weight: 500, preload: false },
] as const;

const fontFaces = FONTS.map(
  (f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/fonts/${f.file}) format('woff2')}`,
).join("\n");
const fontPreloads = FONTS.filter((f) => f.preload)
  .map((f) => `<link rel="preload" href="/fonts/${f.file}" as="font" type="font/woff2" crossorigin>`)
  .join("\n");

const PLANNED_DEPARTMENTS = [
  { id: "manufacturing", name: "Manufacturing", purpose: "Casting, bench time and job costs, from wax to finished piece." },
  { id: "wholesale", name: "Wholesale and memo", purpose: "Memo exposure, sell-through by door and the same stone listed twice." },
];

/**
 * Plain-language label for each catalog domain. Keyed by string so a domain
 * the catalog adds later still builds; a test fails until it gets a label.
 */
export const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  pos: "Point of sale",
  ecommerce: "E-commerce",
  financial: "Money",
  crm: "Customers",
  communication: "Messaging",
  documents: "Documents",
  marketing: "Marketing",
  diamonds: "Diamonds and gems",
  suppliers: "Suppliers",
  grading: "Grading and appraisal",
  pricing: "Pricing",
  erp: "Manufacturing and ERP",
  edi: "EDI",
  insurance: "Insurance",
  shipping: "Shipping",
  operations: "Store operations",
};

export function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain[0]!.toUpperCase() + domain.slice(1);
}

/**
 * What each kind of connection is worth to the owner: the question it
 * answers and why that matters. Keyed by catalog domain; a test fails when a
 * domain with data sources has no entry.
 */
export const DOMAIN_VALUE: Readonly<Record<string, { question: string; why: string }>> = {
  ecommerce: { question: "What sold, where, and what has sat too long?", why: "Aged inventory is cash locked in the case. Seeing it piece by piece is what makes a remake or markdown decision possible." },
  pos: { question: "What happened at the counter today?", why: "The counter is where most of a jeweler's revenue and cash comes in, so it is the first thing every department reads." },
  financial: { question: "Did the money that was rung up arrive, and what did each sale really net?", why: "Fees, refunds, disputes and unmatched deposits are where margin leaks. The books stop being a month-end guess." },
  pricing: { question: "What is this inventory worth today, at melt and at retail?", why: "Gold moves weekly. Repricing at the right moment protects margin, and buying from the public too close to melt erodes it." },
  crm: { question: "Who is this customer, and what did we promise them?", why: "Anniversaries, wish lists and custom-order promises turn into reminders instead of notes nobody reads." },
  communication: { question: "Who asked for what, and did anyone answer?", why: "A missed call or an unanswered email about a custom piece is lost revenue. Response time is a sales number." },
  documents: { question: "Where is the appraisal, the quote or the vendor terms?", why: "The paperwork behind a decision is linked to the record, not lost in a shared drive." },
  marketing: { question: "Which campaigns brought buyers, not just clicks?", why: "Marketing is judged by the sales it brought in, so you repeat what worked and stop what didn't." },
  diamonds: { question: "What can I source for the customer in front of me, and at what cost?", why: "Custom quotes go out the same day, priced from what is really available." },
  suppliers: { question: "What did I order, what is on memo, and what does it cost to replace?", why: "Memo goods come back on time, and nothing is priced below its replacement cost." },
  grading: { question: "Is this stone what the paperwork says it is?", why: "Grading reports and appraisals are checked against the piece before it is sold or insured." },
  erp: { question: "What did this piece cost to make, in metal and in bench time?", why: "Casting loss and labor per job show which work actually makes money." },
  edi: { question: "Which orders and invoices came in from trading partners?", why: "Purchase orders and invoices land without retyping, and match what was shipped." },
  insurance: { question: "What is insured, and for how much?", why: "Inventory and appraisal values stay in step with the policy, so nothing is under-covered." },
  shipping: { question: "Where is the package, and was it insured for its value?", why: "High-value shipments are tracked and covered, and a delay reaches the customer before they ask." },
};

/** Dates for the holiday pilot the site announces. */
export const HOLIDAY_PILOT = { weekend: "November 21–22, 2026", signupsOpen: "November 16" } as const;

/**
 * Illustrative plays: what happens when several connected systems are read
 * together. Each names the catalog systems it combines, by id, and the one
 * action that comes out of it. A test checks every id is in the catalog, and
 * rendering stops on an unknown one.
 */
export interface Play {
  title: string;
  systems: string[];
  action: string;
}

export const PLAYS: readonly Play[] = [
  {
    title: "An anniversary nobody has to remember",
    systems: ["inventory_pos", "clientbook", "klaviyo", "calendly"],
    action: "Three years after a band sold, the client's salesperson gets a nudge, the matching earrings are flagged in stock, and an invitation to book a fitting is drafted for the right day.",
  },
  {
    title: "A late repair that doesn't become a bad review",
    systems: ["monday", "twilio", "google_business_profile"],
    action: "A ring past its promised date gets a text drafted to the customer before they ask, and the review request waits until it's picked up happy.",
  },
  {
    title: "Pieces priced below what they cost to replace",
    systems: ["metals_api", "stuller", "shopify"],
    action: "When gold moves, every item whose shelf or website price is now under its replacement cost is listed for a reprice.",
  },
  {
    title: "Which memo stones to send back",
    systems: ["rapnet", "nivoda", "polygon", "quickbooks"],
    action: "When diamond prices move, buying sees which stones on memo to return before the memo is due.",
  },
  {
    title: "A reportable cash sale, caught",
    systems: ["inventory_pos", "bank_statements", "fincen_8300"],
    action: "Cash sales are matched to bank deposits, and any buyer who paid over $10,000 in cash gets a Form 8300 ready to file on time.",
  },
  {
    title: "A watch sold in store, still listed online",
    systems: ["inventory_pos", "ebay", "shopify"],
    action: "A pre-owned watch that sold at the counter is still up on the marketplace and the website. Both listings are flagged to come down today.",
  },
];

/** The write-back rules the site promises, in the order it lists them. */
export const WRITE_RULES: readonly { title: string; body: string }[] = [
  { title: "Every connection starts read-only", body: "KaratOS reads first. Nothing goes back into your systems on day one." },
  { title: "Off until you turn it on", body: "Writing back is off until your business turns it on, per system and per action." },
  { title: "Drafts and additions, never deletions", body: "KaratOS prefers a draft or a new note over changing a record, and it never deletes." },
  { title: "A person approves each write", body: "Nothing is written without someone on your team saying yes to it." },
  { title: "Checked again, right before", body: "It re-checks the record right before writing, so it works from the record as it is now, not as it was this morning." },
  { title: "Capped per day", body: "Each system has a daily limit on writes, so a mistake stays small." },
  { title: "Read back to confirm", body: "After every write it reads the record back to confirm it landed as approved." },
  { title: "Can be undone", body: "Every write can be undone." },
  { title: "One mismatch stops everything", body: "If a read-back doesn't match, all writes to that system stop until a person checks." },
];

const ACCESS_LABELS: Record<IntegrationSpec["access"], string> = {
  public_api: "Public API",
  partner: "Partner",
  edi: "EDI",
  file: "File import",
  unknown: "To confirm",
};

/** Self-serve integrations that are not deferred: the ones being built now. */
export function buildingNow(): IntegrationSpec[] {
  return selfServeIntegrations().filter((i) => i.status === "planned");
}

/** The hero's early-access line, naming the connectors that are built. */
export function earlyAccessNote(): string {
  const built = INTEGRATIONS.filter((i) => i.status === "built").map((i) => i.name);
  if (!built.length) return "Early access. The first integrations are being built and tested now.";
  const names = built.length === 1 ? built[0]! : `${built.slice(0, -1).join(", ")} and ${built.at(-1)}`;
  return `Early access. ${names} ${built.length === 1 ? "is" : "are"} connected today, and more integrations are being built and tested now.`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function statusOf(integration: IntegrationSpec, selfServe: Set<string>): { label: string; tone: string } {
  if (integration.status === "deferred") return { label: "Deferred", tone: "muted" };
  if (integration.status === "built") return { label: "Connector built", tone: "gold" };
  if (selfServe.has(integration.id)) return { label: "Building now", tone: "gold" };
  return { label: "Planned", tone: "plain" };
}

/**
 * One card per kind of connection (catalog domain), those with built systems
 * first: the question it answers, why it matters, and what is connected today,
 * being built now, or on the roadmap.
 */
export function renderValueCards(dataSources: readonly IntegrationSpec[], selfServe: ReadonlySet<string>): string {
  const domains = [...new Set(dataSources.map((i) => i.domain))];
  const builtIn = (domain: string) => dataSources.filter((i) => i.domain === domain && i.status === "built");
  return domains
    .map((domain, index) => ({ domain, index, built: builtIn(domain).length }))
    .sort((a, b) => b.built - a.built || a.index - b.index)
    .map(({ domain }) => {
      const value = DOMAIN_VALUE[domain];
      if (!value) throw new Error(`domain ${domain} has data sources but no entry in DOMAIN_VALUE`);
      const systems = dataSources.filter((i) => i.domain === domain);
      const built = systems.filter((i) => i.status === "built");
      const next = systems.filter((i) => i.status !== "built" && selfServe.has(i.id));
      const status = built.length
        ? `<p class="value-status live"><strong>Connected today:</strong> ${escapeHtml(built.map((i) => i.name).join(", "))}</p>`
        : next.length
          ? `<p class="value-status"><strong>Building now:</strong> ${escapeHtml(next.map((i) => i.name).join(", "))}</p>`
          : `<p class="value-status"><strong>On the roadmap:</strong> ${systems.length} ${systems.length === 1 ? "system" : "systems"}</p>`;
      return `<li class="value">
  <span class="domain">${escapeHtml(domainLabel(domain))}</span>
  <h3>${escapeHtml(value.question)}</h3>
  <p>${escapeHtml(value.why)}</p>
  ${status}
</li>`;
    })
    .join("\n");
}

export function renderSite(plays: readonly Play[] = PLAYS): string {
  const selfServe = new Set(buildingNow().map((i) => i.id));
  const departments = [
    ...RETAIL_DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose, planned: false })),
    ...PLANNED_DEPARTMENTS.map((d) => ({ ...d, planned: true })),
  ];
  // Built connectors come first, then systems we are building now, then the rest in catalog order.
  const rank = (i: IntegrationSpec) => (i.status === "built" ? 2 : selfServe.has(i.id) ? 1 : 0);
  const dataSources = INTEGRATIONS.filter((i) => i.departments.length > 0).sort((a, b) => rank(b) - rank(a));
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  const cards = dataSources
    .map((i) => {
      const status = statusOf(i, selfServe);
      const depts = i.departments.map((d) => deptName.get(d) ?? d);
      const search = [i.name, domainLabel(i.domain), ...depts, ...i.segments].join(" ").toLowerCase();
      return `<li class="card" data-segments="${i.segments.join(" ")}" data-departments="${i.departments.join(" ")}" data-search="${escapeHtml(search)}">
  <div class="card-top"><span class="domain">${escapeHtml(domainLabel(i.domain))}</span><span class="pill ${status.tone}">${status.label}</span></div>
  <h3>${escapeHtml(i.name)}</h3>
  <p class="meta">${escapeHtml(ACCESS_LABELS[i.access])} · ${i.segments.map((s) => s[0]!.toUpperCase() + s.slice(1)).join(", ")}</p>
  <p class="depts">${escapeHtml(depts.join(", "))}</p>${
    i.status === "built" && i.capabilities?.length
      ? `\n  <ul class="caps" aria-label="What you get with ${escapeHtml(i.name)}">${i.capabilities.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
      : ""
  }
</li>`;
    })
    .join("\n");

  const byId = new Map(INTEGRATIONS.map((i) => [i.id, i]));
  const playCards = plays.map((play) => {
    const systems = play.systems.map((id) => {
      const integration = byId.get(id);
      if (!integration) throw new Error(`play "${play.title}" names ${id}, which is not in the integrations catalog`);
      return `<li>${escapeHtml(integration.name)}</li>`;
    });
    return `<li class="play">
  <span class="tag">Illustrative</span>
  <h3>${escapeHtml(play.title)}</h3>
  <ul class="play-systems" aria-label="Systems combined">${systems.join("")}</ul>
  <p class="play-action"><strong>Result:</strong> ${escapeHtml(play.action)}</p>
</li>`;
  }).join("\n");
  const writeRules = WRITE_RULES.map((r) => `<li><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml(r.body)}</p></li>`).join("\n");

  const valueCards = renderValueCards(dataSources, selfServe);

  const deptOptions = departments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
  const deptCards = departments
    .map(
      (d) => `<li class="dept${d.planned ? " planned" : ""}"><h3>${escapeHtml(d.name)}${d.planned ? ' <span class="pill muted">Next</span>' : ""}</h3><p>${escapeHtml(d.purpose)}</p></li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KaratOS</title>
<meta name="description" content="KaratOS connects the many systems a jewelry or watch business already runs, reads them together and turns them into a short list of things to act on, each with the evidence behind it. It writes back only with a person's approval.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 3 28 12 16 29 4 12Z' fill='%23c9a45c'/%3E%3C/svg%3E">
${fontPreloads}
<style>
${fontFaces}
/* --gold-text and --gold-on-ink keep gold lettering at 4.5:1 or better (WCAG AA) on light surfaces and on the inverted campaign panel. */
:root{--bg:#faf8f4;--surface:#ffffff;--ink:#16140f;--ink-2:#4a463d;--muted:#6b665b;--line:#e7e2d8;--gold:#a8833d;--gold-text:#82632a;--gold-on-ink:#d4b06a;--gold-soft:#f4ecdc;--radius:14px;--space-1:8px;--space-2:16px;--space-3:24px;--space-4:32px;--space-5:48px;--section:clamp(64px,9vw,96px);--sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--surface:#1b1a17;--ink:#f3efe6;--ink-2:#c8c1b3;--muted:#948d80;--line:#2e2b26;--gold:#d4b06a;--gold-text:#d4b06a;--gold-on-ink:#82632a;--gold-soft:#2a2418}body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 var(--sans);text-rendering:optimizeLegibility;font-kerning:normal;font-variant-ligatures:common-ligatures}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.nav{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:16px}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:20px;letter-spacing:-.01em;text-decoration:none}
.brand svg{width:22px;height:22px}
.nav nav{display:flex;gap:24px;font-size:14px;color:var(--ink-2)}
.nav nav a{text-decoration:none;white-space:nowrap}
.nav nav a:hover{color:var(--ink)}
@media (max-width:1120px){.nav nav{display:none}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:999px;font-weight:600;font-size:15px;text-decoration:none;border:1px solid var(--ink);transition:transform .15s ease}
.btn:hover{transform:translateY(-1px)}
.btn.primary{background:var(--ink);color:var(--bg)}
.btn.ghost{background:transparent;color:var(--ink)}
.btn.small{padding:8px 16px;font-size:14px}
.hero{padding-top:var(--section);padding-bottom:var(--section)}
.eyebrow{display:block;width:fit-content;font-family:var(--mono);font-size:13px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--gold-text);margin-bottom:var(--space-2);line-height:1.4}
h1,h2{font-weight:600;letter-spacing:-.015em;line-height:1.1;margin:0;text-wrap:balance}
h1{font-size:clamp(40px,7vw,76px);max-width:14ch}
h2{font-size:clamp(30px,4.5vw,46px);max-width:20ch}
.lede{font-size:clamp(17px,2.2vw,20px);color:var(--ink-2);max-width:60ch;margin:var(--space-3) 0 var(--space-4)}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.note{margin:var(--space-3) 0 0;font-size:14px;color:var(--muted)}
section{padding:var(--section) 0;border-top:1px solid var(--line);scroll-margin-top:64px}
/* Below-the-fold sections skip layout and paint until they near the viewport: the integrations catalog alone is hundreds of elements. */
section{content-visibility:auto;contain-intrinsic-size:auto 900px}
.section-intro{color:var(--ink-2);max-width:62ch;margin:var(--space-2) 0 var(--space-5);font-size:17px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-3);list-style:none;padding:0;margin:0;counter-reset:step}
.steps li{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3);counter-increment:step}
.steps li::before{content:counter(step,decimal-leading-zero);font-family:var(--mono);font-weight:500;color:var(--gold);font-size:28px;display:block;margin-bottom:var(--space-2)}
.steps h3,.dept h3,.card h3{margin:0 0 8px;font-size:18px}
.steps p,.dept p{margin:0;color:var(--ink-2)}
@media (max-width:860px){.steps{grid-template-columns:1fr}}
.example{margin-top:var(--space-4);background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:var(--radius);padding:var(--space-3);max-width:720px}
.example .tag{font-family:var(--mono);font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--gold-text)}
.example p{margin:8px 0 0}
.example .why{color:var(--muted);font-size:14px}
.plays{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--space-3);list-style:none;padding:0;margin:0}
.play{background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--gold);border-radius:var(--radius);padding:var(--space-3);display:flex;flex-direction:column}
.play .tag{font-family:var(--mono);font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--gold-text)}
.play h3{margin:var(--space-1) 0 var(--space-2);font-size:18px;line-height:1.3}
.play-systems{display:flex;flex-wrap:wrap;gap:var(--space-1);list-style:none;padding:0;margin:0 0 var(--space-2)}
.play-systems li{font-size:13px;line-height:1.4;padding:4px 12px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--ink-2)}
.play-systems li+li::before{content:"+ ";color:var(--gold-text)}
.play-action{margin:auto 0 0;padding-top:var(--space-2);border-top:1px solid var(--line);color:var(--ink-2);font-size:15px}
.play-action strong{color:var(--ink)}
.rules{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-3);list-style:none;padding:0;margin:0}
.rules li{padding-top:var(--space-2);border-top:2px solid var(--gold)}
.rules h3{margin:0 0 8px;font-size:18px}
.rules p{margin:0;color:var(--ink-2)}
@media (max-width:860px){.rules{grid-template-columns:1fr}}
.source{margin-top:var(--space-5);background:var(--gold-soft);border-radius:var(--radius);padding:var(--space-4);max-width:820px}
.source h3{margin:0 0 var(--space-1);font-size:20px}
.source p{margin:0;color:var(--ink-2)}
.depts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:var(--space-3);list-style:none;padding:0;margin:0}
.dept{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3)}
.dept.planned{background:transparent;border-style:dashed}
.stats{display:flex;flex-wrap:wrap;gap:var(--space-4);margin:0 0 var(--space-4)}
.stat strong{display:block;font-family:var(--mono);font-weight:500;font-size:40px;line-height:1;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:14px}
.filters{display:grid;grid-template-columns:2fr 1fr 1fr;gap:var(--space-2);margin-bottom:var(--space-3)}
.filters input,.filters select{width:100%;padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit}
@media (max-width:760px){.filters{grid-template-columns:1fr}}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:var(--space-3);list-style:none;padding:0;margin:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3)}
.card[hidden]{display:none}
.card-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:var(--space-1)}
.domain{font-family:var(--mono);font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.meta{margin:0;font-size:14px;color:var(--ink-2)}
.depts{margin:var(--space-1) 0 0;font-size:13px;color:var(--muted)}
.caps{margin:var(--space-2) 0 0;padding:var(--space-2) 0 0 var(--space-3);border-top:1px solid var(--line);font-size:14px;color:var(--ink-2)}
.caps li{margin:0 0 4px}
.pill{font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;font-family:var(--sans)}
.pill.gold{background:var(--gold-soft);color:var(--gold-text);border-color:transparent}
.pill.muted{color:var(--muted)}
.empty{color:var(--muted);padding:var(--space-3) 0}
.pillars{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-3)}
.pillars div{padding-top:var(--space-3);border-top:2px solid var(--gold)}
.pillars h3{margin:0 0 8px;font-size:18px}
.pillars p{margin:0;color:var(--ink-2)}
@media (max-width:860px){.pillars{grid-template-columns:1fr}}
.services{display:grid;grid-template-columns:1.1fr 1fr;gap:var(--space-5);margin-bottom:var(--space-5)}
@media (max-width:860px){.services{grid-template-columns:1fr}}
.console-preview{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3);box-shadow:0 12px 32px -18px rgba(0,0,0,.25)}
.cp-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:var(--space-2)}
.cp-row{border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:var(--space-1)}
.cp-row.act{border-left:4px solid var(--gold)}
.cp-row p{margin:4px 0 0;font-size:15px}
.cp-dept{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.cp-note{margin:var(--space-1) 0 0;font-size:13px;color:var(--muted)}
.why-console h3{margin:0 0 var(--space-2);font-size:20px}
.why-console ul{margin:0;padding-left:var(--space-3);color:var(--ink-2)}
.why-console li{margin-bottom:var(--space-2)}
.why-console strong{color:var(--ink)}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-3);list-style:none;padding:0;margin:0}
@media (max-width:860px){.plans{grid-template-columns:1fr}}
.plan{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3);display:flex;flex-direction:column;gap:var(--space-1)}
.plan.featured{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold)}
.plan h3{margin:0;font-size:20px}
.plan .price{margin:0;color:var(--muted)}
.plan .price strong{font-size:34px;letter-spacing:-.02em;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;margin-right:4px}
.plan p{margin:0 0 var(--space-2);color:var(--ink-2)}
.plan .btn{margin-top:var(--space-2);align-self:flex-start}
.plan .fine{font-size:13px;color:var(--muted)}
.plan .price+p{flex:1}
.contact{display:grid;grid-template-columns:1fr 2fr;gap:var(--space-5);margin-top:var(--space-5);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-4);scroll-margin-top:72px}
@media (max-width:860px){.contact{grid-template-columns:1fr}}
.contact h3{margin:0 0 var(--space-1);font-size:22px}
.contact-intro p{margin:0;color:var(--ink-2)}
#inquiry{display:grid;gap:var(--space-2)}
#inquiry label{display:grid;gap:var(--space-1);font-size:14px;font-weight:500}
#inquiry input,#inquiry select,#inquiry textarea{width:100%;padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
#inquiry .row{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2)}
@media (max-width:560px){#inquiry .row{grid-template-columns:1fr}}

.interests{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-3)}
.interests legend{font-size:14px;font-weight:500;margin-bottom:var(--space-1)}
.interests label{display:flex!important;align-items:center;gap:8px;font-weight:400}
.interests input{width:auto!important}
.values{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--space-3);list-style:none;padding:0;margin:0}
.value{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3);display:flex;flex-direction:column}
.value .domain{font-family:var(--mono);font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--gold-text)}
.value h3{margin:var(--space-1) 0 var(--space-2);font-size:18px;line-height:1.3}
.value p{margin:0;color:var(--ink-2);font-size:15px}
.value .value-status{margin:auto 0 0;padding-top:var(--space-2);margin-top:var(--space-2);border-top:1px solid var(--line);font-size:14px}
.value .value-status.live strong{color:var(--gold-text)}
.pilot{display:grid;grid-template-columns:1.2fr 1fr;gap:var(--space-4);align-items:start}
.pilot ul{margin:0;padding-left:20px;color:var(--ink-2)}
.pilot li+li{margin-top:var(--space-1)}
.pilot .when{background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--gold);border-radius:var(--radius);padding:var(--space-3)}
.pilot .when strong{display:block;font-size:24px;line-height:1.2;margin:var(--space-1) 0}
@media (max-width:860px){.pilot{grid-template-columns:1fr}}
#inquiry .invalid{border-color:#c0392b}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.submit-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
#inquiry-status{margin:0;font-size:14px;color:var(--ink-2)}
#broken{border-top:0}
.campaign{background:var(--ink);color:var(--bg);border-radius:24px;padding:clamp(32px,6vw,64px);border:0}
.campaign h2{max-width:22ch}
.campaign .eyebrow{color:var(--gold-on-ink)}
.campaign p{color:color-mix(in srgb,var(--bg) 78%,transparent);max-width:60ch;font-size:17px;margin:var(--space-3) 0 var(--space-4)}
.campaign .btn.primary{background:var(--gold);border-color:var(--gold);color:#16140f}
.campaign .small{font-size:14px;margin:var(--space-3) 0 0}
.campaign .small a{color:var(--gold)}
footer{padding:var(--space-5) 0;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-2)}
</style>
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="#top"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 28 12 16 29 4 12Z" fill="#c9a45c"/><path d="M4 12h24M16 3l-5 9 5 17 5-17-5-9" fill="none" stroke="#16140f" stroke-opacity=".35" stroke-width="1.2"/></svg>KaratOS</a>
  <nav><a href="#how">How it works</a><a href="#together">Systems together</a><a href="#write-back">Write-back</a><a href="#integrations">Integrations</a><a href="#pilot">Holiday pilot</a><a href="#services">Pricing</a><a href="#broken">What's broken</a></nav>
  <a class="btn primary small" href="#services">Custom services</a>
</div></header>

<main id="top">
<div class="wrap hero">
  <span class="eyebrow">For jewelers, watch dealers, wholesalers and manufacturers</span>
  <h1>The operating brain for jewelry businesses.</h1>
  <p class="lede">KaratOS connects the many systems your business already runs, from the POS and the books to diamond feeds and the repair bench, reads them together and turns them into a short list of things to act on today. Every suggestion shows the evidence behind it, and when you allow it, KaratOS writes back carefully, one approved change at a time.</p>
  <div class="actions"><a class="btn primary" href="#pilot">Join the holiday pilot</a><a class="btn ghost" href="#services">Custom services</a><a class="btn ghost" href="#together">See the systems work together</a></div>
  <p class="note">${escapeHtml(earlyAccessNote())}</p>
</div>

<section id="how"><div class="wrap">
  <h2>From scattered systems to a clear next step.</h2>
  <p class="section-intro">Most jewelry businesses run a dozen systems that don't talk to each other. KaratOS connects to as many of them as you run, from ${dataSources.length} systems on our map, reads them together, and tells you what matters.</p>
  <ol class="steps">
    <li><h3>Connect everything, read-only</h3><p>Link your POS, store, books, bank statements (CSV or PDF), suppliers, messaging and price feeds, as many as you run. Every connection starts read-only.</p></li>
    <li><h3>Understand across departments</h3><p>A sale, a late repair, a stone on memo and a jump in gold all become signals, and each department sees what the others are doing.</p></li>
    <li><h3>Act, and write back carefully</h3><p>Each morning, a short list: what to do, why, and the records behind it. Accept, snooze or dismiss. Where you've turned write-back on, a person approves each draft before it goes into your system.</p></li>
  </ol>
  <div class="example">
    <span class="tag">Example</span>
    <p><strong>Call the Hendersons today.</strong> Their anniversary is in 9 days, they bought a band here three years ago, and the matching earrings came back in stock this week.</p>
    <p class="why">Why: based on 4 events from clienteling, sales and inventory. Illustrative.</p>
  </div>
</div></section>

<section id="together"><div class="wrap">
  <span class="eyebrow">Systems that work together</span>
  <h2>One system knows a little. Together they know what to do.</h2>
  <p class="section-intro">The win isn't any single connection. It's a sale in the POS meeting a date in the client book, or a gold price meeting a supplier's catalog and your website. A few of the plays that only exist once your systems are read together:</p>
  <ul class="plays">
${playCards}
  </ul>
</div></section>

<section id="value"><div class="wrap">
  <span class="eyebrow">What each connection is worth</span>
  <h2>Every system you connect answers a question the others can't.</h2>
  <p class="section-intro">KaratOS is useful with one connection and sharper with each one. Here is the question each kind of system answers for the owner, why it matters, and what is connected today.</p>
  <ul class="values">
${valueCards}
  </ul>
</div></section>

<section id="write-back"><div class="wrap">
  <span class="eyebrow">Write-back</span>
  <h2>Reads freely. Writes carefully.</h2>
  <p class="section-intro">Reading more of your systems makes for better suggestions. Writing back saves your team the typing, but one wrong change in your system costs trust, so KaratOS has to be twice as sure before it writes as when it reads.</p>
  <ul class="rules">
${writeRules}
  </ul>
  <div class="source">
    <h3>Your systems stay the source of truth.</h3>
    <p>KaratOS writes into the POS, store, books and client book you already run, rather than becoming another database to pay for and keep in sync.</p>
  </div>
</div></section>

<section id="departments"><div class="wrap">
  <h2>Built for every department.</h2>
  <p class="section-intro">Each business turns on the departments it runs. Recommendations cross departments, so a repair running late reaches the client book before the customer calls.</p>
  <ul class="depts-grid">
${deptCards}
  </ul>
</div></section>

<section id="integrations"><div class="wrap">
  <h2>Integrations</h2>
  <p class="section-intro">Every system on our map, who uses it and how we connect. "Building now" means we can build and test it without waiting on anyone. Everything else follows.</p>
  <div class="stats">
    <div class="stat"><strong>${dataSources.length}</strong><span>systems mapped</span></div>
    <div class="stat"><strong>${selfServe.size}</strong><span>building now</span></div>
    <div class="stat"><strong>${departments.length}</strong><span>departments served</span></div>
  </div>
  <div class="filters" role="search">
    <input id="q" type="search" placeholder="Search systems, e.g. Shopify, repairs, diamonds" aria-label="Search integrations">
    <select id="segment" aria-label="Kind of business"><option value="">Every kind of business</option><option value="retail">Retail</option><option value="wholesale">Wholesale</option><option value="manufacturing">Manufacturing</option></select>
    <select id="department" aria-label="Department"><option value="">Every department</option>${deptOptions}</select>
  </div>
  <ul class="cards" id="cards">
${cards}
  </ul>
  <p class="empty" id="empty" hidden>Nothing matches. <a href="#broken">Tell us about it</a> and we'll add it.</p>
</div></section>

<section id="pilot"><div class="wrap">
  <span class="eyebrow">Holiday pilot</span>
  <h2>Test it before Black Friday.</h2>
  <div class="pilot">
    <div>
      <p class="section-intro">The weeks before Black Friday decide a jeweler's year, so that is when KaratOS has to prove itself. Join the open testing weekend and get your first list of recommendations before the rush.</p>
      <ul>
        <li><strong>Read-only from the first minute.</strong> Connect your store, POS, payments or bank. Nothing in your systems is changed.</li>
        <li><strong>A list by the end of the day.</strong> Aged pieces to reprice, late repairs to call about, deposits that don't match, deadlines coming up.</li>
        <li><strong>Your feedback shapes the launch.</strong> Every accept, snooze and dismiss tells us what to sharpen before stores rely on it.</li>
      </ul>
    </div>
    <div class="when">
      <span class="eyebrow">Testing weekend</span>
      <strong>${HOLIDAY_PILOT.weekend}</strong>
      <p>Sign-ups open ${HOLIDAY_PILOT.signupsOpen}. Places are limited so we can help every store connect.</p>
      <div class="actions"><a class="btn primary" href="${CONTACT_ANCHOR}" data-interest="pilot">Join the pilot</a></div>
    </div>
  </div>
</div></section>

<section id="your-data"><div class="wrap">
  <h2>Your instance. Your data.</h2>
  <p class="section-intro">KaratOS runs as a private instance for your business alone. On Core it lives in accounts you own; on Managed we run it for you, still walled off from every other client.</p>
  <div class="pillars">
    <div><h3>No one else sees it</h3><p>On Core, once setup is done we have no access. On Managed, we reach your instance only to keep it running. Either way, your sales, customers, statements and margins stay in your instance.</p></div>
    <div><h3>Nothing shared by default</h3><p>Your data is never used to price, benchmark or advise another business unless you both opt in.</p></div>
    <div><h3>You choose who runs it</h3><p>Have the bandwidth? Keep it in your own accounts on Core. Rather not? Managed means we host it, keep it current and fix connections when a vendor changes something.</p></div>
  </div>
</div></section>

<section id="services"><div class="wrap">
  <span class="eyebrow">Custom services</span>
  <h2>We build it, connect it and keep it running.</h2>
  <p class="section-intro">One price per store, with the Brain Console and every standard connection included. Run it in your own accounts, or have us run it for you.</p>
  <div class="services">
    <div class="console-preview" aria-label="Brain Console preview">
      <div class="cp-head"><span>Brain Console</span><span class="pill gold">3 need you today</span></div>
      <div class="cp-row act"><span class="cp-dept">Repairs</span><p>Call about the Rivera ring. Promised Friday, still at the setter.</p></div>
      <div class="cp-row"><span class="cp-dept">Inventory</span><p>Seven aged pieces are worth more at melt than on the case.</p></div>
      <div class="cp-row"><span class="cp-dept">Clienteling</span><p>Twelve anniversaries in the next two weeks with a matching piece in stock.</p></div>
      <p class="cp-note">Illustrative. Every card shows the records behind it, and Accept, Snooze or Dismiss.</p>
    </div>
    <div class="why-console">
      <h3>Why the Brain Console</h3>
      <ul>
        <li><strong>One list for the whole business.</strong> Sales, repairs, buying, metals and the books in one place, ranked by what needs you first.</li>
        <li><strong>The evidence, every time.</strong> Each suggestion shows the sales, tickets and statements it came from, and says when its data is out of date.</li>
        <li><strong>Gets sharper as you use it.</strong> What you accept, snooze and dismiss tunes what it shows tomorrow.</li>
        <li><strong>Private by design.</strong> It runs on your own instance. On Core we can't see your numbers at all.</li>
      </ul>
    </div>
  </div>
  <ul class="plans">
    <li class="plan">
      <h3>Core</h3>
      <p class="price"><strong>${CORE_PRICE}</strong> per store per month</p>
      <p>The Brain Console with 3 seats, every standard connection and every retail department, running in accounts your business owns.</p>
      <p class="fine">One-time setup fee. Extra seats $49 a month.</p>
      <a class="btn ghost" href="${CONTACT_ANCHOR}" data-interest="brain_console">Start on Core</a>
    </li>
    <li class="plan featured">
      <h3>Managed</h3>
      <p class="price"><strong>${MANAGED_PRICE}</strong> per store per month</p>
      <p>Everything in Core with 5 seats, and we host it, watch every sync, keep it current and fix connections when a vendor changes something. Includes Dashboard Studio.</p>
      <p class="fine">One-time setup fee. Extra seats $49 a month.</p>
      <a class="btn primary" href="${CONTACT_ANCHOR}" data-interest="maintenance">Go Managed</a>
    </li>
    <li class="plan">
      <h3>Multi-store and custom</h3>
      <p class="price"><strong>By quote</strong></p>
      <p>Several locations or a wholesale business, partner systems, integrations no one else builds, and moving years of history out of old systems.</p>
      <a class="btn ghost" href="${CONTACT_ANCHOR}" data-interest="custom_services">Ask for a quote</a>
    </li>
  </ul>

  <div id="contact" class="contact">
    <div class="contact-intro">
      <h3>Talk to us</h3>
      <p>Tell us what you run and what you need. This goes privately to our team and is never posted publicly.</p>
    </div>
    <form id="inquiry" novalidate>
      <fieldset class="interests"><legend>Interested in</legend>
        <label><input type="checkbox" name="interests" value="pilot"> Holiday pilot</label>
        <label><input type="checkbox" name="interests" value="brain_console"> Core plan</label>
        <label><input type="checkbox" name="interests" value="maintenance"> Managed plan</label>
        <label><input type="checkbox" name="interests" value="custom_services"> Custom services</label>
        <label><input type="checkbox" name="interests" value="broken_system"> Reporting a broken system</label>
      </fieldset>
      <div class="row">
        <label>Your name<input name="name" autocomplete="name" maxlength="120" required></label>
        <label>Email<input name="email" type="email" autocomplete="email" maxlength="200" required></label>
      </div>
      <div class="row">
        <label>Business<input name="business" autocomplete="organization" maxlength="160" required></label>
        <label>Kind of business<select name="businessType" required><option value="">Choose one</option><option value="retail">Retail store</option><option value="wholesale">Wholesaler or diamond dealer</option><option value="manufacturing">Manufacturer</option><option value="other">Other</option></select></label>
      </div>
      <div class="row">
        <label class="seats">People who'd use the dashboard<input name="seats" type="number" min="1" max="10000" inputmode="numeric"></label>
        <label>System that isn't working, if any<input name="system" maxlength="160" placeholder="e.g. your POS, a memo spreadsheet"></label>
      </div>
      <label>What do you need?<textarea name="message" rows="5" maxlength="4000" required placeholder="The systems you run, what isn't working, and what you'd like built."></textarea></label>
      <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <div class="submit-row"><button class="btn primary" type="submit">Send</button><p id="inquiry-status" role="status" aria-live="polite"></p></div>
    </form>
  </div>
</div></section>

<section id="broken"><div class="wrap">
  <div class="campaign">
    <span class="eyebrow">Open call</span>
    <h2>Is a system in your jewelry business broken? Tell us.</h2>
    <p>The POS that won't export, the feed that lists a sold stone, the memo tracked on paper, the statements retyped every month. If something in your stack doesn't work, or doesn't talk to the rest, we want to hear about it and build around it.</p>
    <div class="actions"><a class="btn primary" href="${CONTACT_ANCHOR}" data-interest="broken_system">Tell us privately</a></div>
    <p class="small">The private form goes only to our team, and we reply within a week. Happy to say it in public? <a href="${REPORT_URL}">Post it on GitHub</a> instead, leaving out passwords, customer names and figures.</p>
  </div>
</div></section>
</main>

<footer><div class="wrap">
  <span>KaratOS. The core engine is open source under the MIT license. The Brain Console and custom services are paid.</span>
  <a href="${REPO_URL}">Open-source core on GitHub</a>
</div></footer>

<script>
(function(){
  var q=document.getElementById('q'),seg=document.getElementById('segment'),dep=document.getElementById('department');
  var cards=[].slice.call(document.querySelectorAll('#cards .card')),empty=document.getElementById('empty');
  function apply(){
    var text=q.value.trim().toLowerCase(),s=seg.value,d=dep.value,shown=0;
    cards.forEach(function(c){
      var ok=(!text||c.dataset.search.indexOf(text)>-1)&&(!s||c.dataset.segments.split(' ').indexOf(s)>-1)&&(!d||c.dataset.departments.split(' ').indexOf(d)>-1);
      c.hidden=!ok; if(ok) shown++;
    });
    empty.hidden=shown>0;
  }
  q.addEventListener('input',apply);seg.addEventListener('change',apply);dep.addEventListener('change',apply);
})();
(function(){
  var form=document.getElementById('inquiry'),status=document.getElementById('inquiry-status');
  document.querySelectorAll('[data-interest]').forEach(function(a){
    a.addEventListener('click',function(){
      var box=form.querySelector('input[name=interests][value="'+a.dataset.interest+'"]'); if(box) box.checked=true;
    });
  });
  form.addEventListener('submit',function(e){
    e.preventDefault();
    form.querySelectorAll('.invalid').forEach(function(el){el.classList.remove('invalid')});
    var data={interests:[].map.call(form.querySelectorAll('input[name=interests]:checked'),function(b){return b.value})};
    ['name','email','business','businessType','seats','system','message','website'].forEach(function(k){data[k]=form.elements[k].value});
    var button=form.querySelector('button');button.disabled=true;status.textContent='Sending...';
    fetch('/api/inquiry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {status:r.status,body:b}})})
      .then(function(r){
        if(r.status===202){form.reset();status.textContent='Thanks. We have it and will be in touch.';return}
        if(r.status===400&&r.body.fields){
          r.body.fields.forEach(function(f){var el=f==='interests'?form.querySelector('.interests'):form.elements[f];if(el)el.classList.add('invalid')});
          status.textContent='Please check the highlighted fields.';return}
        status.textContent=r.status===429?'That is a lot of messages. Please try again in an hour.':'We could not send that just now. Please try again soon.';
      })
      .catch(function(){status.textContent='We could not send that just now. Please try again soon.'})
      .then(function(){button.disabled=false});
  });
})();
</script>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = new URL("./dist/", import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL("index.html", out), renderSite());
  const fonts = new URL("fonts/", out);
  mkdirSync(fonts, { recursive: true });
  const require = createRequire(import.meta.url);
  for (const f of FONTS) copyFileSync(require.resolve(f.pkg), new URL(f.file, fonts));
  console.log(`wrote ${fileURLToPath(new URL("index.html", out))}`);
}
