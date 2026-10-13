/**
 * Builds the KaratOS website into site/dist. The integration directory and
 * department list come straight from the code, so the site never drifts from
 * what the engine actually supports.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTEGRATIONS, selfServeIntegrations, type IntegrationSpec } from "../packages/core/src/index.js";
import { RETAIL_DEPARTMENTS } from "../packages/retail/src/index.js";

export const REPORT_URL =
  "https://github.com/aasimsayani/karatos-brain/issues/new?template=integration-request.yml";
export const REPO_URL = "https://github.com/aasimsayani/karatos-brain";
/** Quote and Brain Console requests go to the private form on the page. */
export const CONTACT_ANCHOR = "#contact";
export const CONSOLE_PRICE = "$99";

const PLANNED_DEPARTMENTS = [
  { id: "manufacturing", name: "Manufacturing", purpose: "Casting, bench time and job costs, from wax to finished piece." },
  { id: "wholesale", name: "Wholesale and memo", purpose: "Memo exposure, sell-through by door and the same stone listed twice." },
];

const DOMAIN_LABELS: Record<IntegrationSpec["domain"], string> = {
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
};

const ACCESS_LABELS: Record<IntegrationSpec["access"], string> = {
  public_api: "Public API",
  partner: "Partner",
  edi: "EDI",
  file: "File import",
  unknown: "To confirm",
};

/** Self-serve integrations that are not deferred: the ones being built now. */
export function buildingNow(): IntegrationSpec[] {
  return selfServeIntegrations().filter((i) => i.status !== "deferred");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function statusOf(integration: IntegrationSpec, selfServe: Set<string>): { label: string; tone: string } {
  if (integration.status === "deferred") return { label: "Deferred", tone: "muted" };
  if (selfServe.has(integration.id)) return { label: "Building now", tone: "gold" };
  return { label: "Planned", tone: "plain" };
}

export function renderSite(): string {
  const selfServe = new Set(buildingNow().map((i) => i.id));
  const departments = [
    ...RETAIL_DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose, planned: false })),
    ...PLANNED_DEPARTMENTS.map((d) => ({ ...d, planned: true })),
  ];
  // Systems we are building now come first, then the rest in catalog order.
  const dataSources = INTEGRATIONS.filter((i) => i.departments.length > 0).sort(
    (a, b) => Number(selfServe.has(b.id)) - Number(selfServe.has(a.id)),
  );
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  const cards = dataSources
    .map((i) => {
      const status = statusOf(i, selfServe);
      const depts = i.departments.map((d) => deptName.get(d) ?? d);
      const search = [i.name, DOMAIN_LABELS[i.domain], ...depts, ...i.segments].join(" ").toLowerCase();
      return `<li class="card" data-segments="${i.segments.join(" ")}" data-departments="${i.departments.join(" ")}" data-search="${escapeHtml(search)}">
  <div class="card-top"><span class="domain">${escapeHtml(DOMAIN_LABELS[i.domain])}</span><span class="pill ${status.tone}">${status.label}</span></div>
  <h3>${escapeHtml(i.name)}</h3>
  <p class="meta">${escapeHtml(ACCESS_LABELS[i.access])} · ${i.segments.map((s) => s[0]!.toUpperCase() + s.slice(1)).join(", ")}</p>
  <p class="depts">${escapeHtml(depts.join(", "))}</p>
</li>`;
    })
    .join("\n");

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
<meta name="description" content="KaratOS connects the systems a jewelry business already runs and turns them into a short list of things to act on, each with the evidence behind it.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 3 28 12 16 29 4 12Z' fill='%23c9a45c'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#faf8f4;--surface:#ffffff;--ink:#16140f;--ink-2:#4a463d;--muted:#7a7468;--line:#e7e2d8;--gold:#a8833d;--gold-soft:#f4ecdc;--radius:14px}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--surface:#1b1a17;--ink:#f3efe6;--ink-2:#c8c1b3;--muted:#948d80;--line:#2e2b26;--gold:#d4b06a;--gold-soft:#2a2418}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.nav{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-family:Fraunces,serif;font-weight:600;font-size:20px;text-decoration:none}
.brand svg{width:22px;height:22px}
.nav nav{display:flex;gap:22px;font-size:14px;color:var(--ink-2)}
.nav nav a{text-decoration:none}
.nav nav a:hover{color:var(--ink)}
@media (max-width:760px){.nav nav{display:none}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:999px;font-weight:600;font-size:15px;text-decoration:none;border:1px solid var(--ink);transition:transform .15s ease}
.btn:hover{transform:translateY(-1px)}
.btn.primary{background:var(--ink);color:var(--bg)}
.btn.ghost{background:transparent;color:var(--ink)}
.btn.small{padding:9px 16px;font-size:14px}
.hero{padding:96px 0 72px}
.eyebrow{display:inline-block;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);margin-bottom:18px}
h1,h2{font-family:Fraunces,serif;font-weight:600;letter-spacing:-.02em;line-height:1.08;margin:0}
h1{font-size:clamp(40px,7vw,76px);max-width:14ch}
h2{font-size:clamp(30px,4.5vw,46px);max-width:20ch}
.lede{font-size:clamp(17px,2.2vw,20px);color:var(--ink-2);max-width:60ch;margin:24px 0 32px}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.note{margin-top:22px;font-size:14px;color:var(--muted)}
section{padding:80px 0;border-top:1px solid var(--line);scroll-margin-top:64px}
.section-intro{color:var(--ink-2);max-width:62ch;margin:16px 0 40px;font-size:17px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;list-style:none;padding:0;margin:0;counter-reset:step}
.steps li{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:28px;counter-increment:step}
.steps li::before{content:counter(step,decimal-leading-zero);font-family:Fraunces,serif;color:var(--gold);font-size:28px;display:block;margin-bottom:12px}
.steps h3,.dept h3,.card h3{margin:0 0 8px;font-size:18px}
.steps p,.dept p{margin:0;color:var(--ink-2)}
@media (max-width:860px){.steps{grid-template-columns:1fr}}
.example{margin-top:28px;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:var(--radius);padding:24px 28px;max-width:720px}
.example .tag{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--gold)}
.example p{margin:8px 0 0}
.example .why{color:var(--muted);font-size:14px}
.depts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;list-style:none;padding:0;margin:0}
.dept{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:22px}
.dept.planned{background:transparent;border-style:dashed}
.stats{display:flex;flex-wrap:wrap;gap:32px;margin:0 0 28px}
.stat strong{display:block;font-family:Fraunces,serif;font-size:40px;line-height:1}
.stat span{color:var(--muted);font-size:14px}
.filters{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;margin-bottom:20px}
.filters input,.filters select{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit}
@media (max-width:760px){.filters{grid-template-columns:1fr}}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;list-style:none;padding:0;margin:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
.card[hidden]{display:none}
.card-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}
.domain{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.meta{margin:0;font-size:14px;color:var(--ink-2)}
.depts{margin:6px 0 0;font-size:13px;color:var(--muted)}
.pill{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;font-family:Inter,sans-serif}
.pill.gold{background:var(--gold-soft);color:var(--gold);border-color:transparent}
.pill.muted{color:var(--muted)}
.empty{color:var(--muted);padding:24px 0}
.pillars{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.pillars div{padding-top:20px;border-top:2px solid var(--gold)}
.pillars h3{margin:0 0 8px;font-size:18px}
.pillars p{margin:0;color:var(--ink-2)}
@media (max-width:860px){.pillars{grid-template-columns:1fr}}
.services{display:grid;grid-template-columns:1.1fr 1fr;gap:28px;margin-bottom:28px}
@media (max-width:860px){.services{grid-template-columns:1fr}}
.console-preview{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:0 12px 32px -18px rgba(0,0,0,.25)}
.cp-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:14px}
.cp-row{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.cp-row.act{border-left:4px solid var(--gold)}
.cp-row p{margin:4px 0 0;font-size:15px}
.cp-dept{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.cp-note{margin:6px 0 0;font-size:13px;color:var(--muted)}
.why-console h3{margin:0 0 12px;font-size:20px}
.why-console ul{margin:0;padding-left:18px;color:var(--ink-2)}
.why-console li{margin-bottom:12px}
.why-console strong{color:var(--ink)}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;list-style:none;padding:0;margin:0}
@media (max-width:860px){.plans{grid-template-columns:1fr}}
.plan{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:26px;display:flex;flex-direction:column;gap:6px}
.plan.featured{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold)}
.plan h3{margin:0;font-size:20px}
.plan .price{margin:0;color:var(--muted)}
.plan .price strong{font-family:Fraunces,serif;font-size:34px;color:var(--ink);font-weight:600;margin-right:4px}
.plan p{margin:0 0 14px;color:var(--ink-2)}
.plan .btn{margin-top:auto;align-self:flex-start}
.plan .fine{font-size:13px;color:var(--muted)}
.contact{display:grid;grid-template-columns:1fr 2fr;gap:28px;margin-top:40px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:28px;scroll-margin-top:72px}
@media (max-width:860px){.contact{grid-template-columns:1fr}}
.contact h3{margin:0 0 8px;font-size:22px;font-family:Fraunces,serif}
.contact-intro p{margin:0;color:var(--ink-2)}
#inquiry{display:grid;gap:14px}
#inquiry label{display:grid;gap:6px;font-size:14px;font-weight:500}
#inquiry input,#inquiry select,#inquiry textarea{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
#inquiry .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:560px){#inquiry .row{grid-template-columns:1fr}}
#inquiry .seats{max-width:260px}
.interests{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:10px 18px}
.interests legend{font-size:14px;font-weight:500;margin-bottom:8px}
.interests label{display:flex!important;align-items:center;gap:8px;font-weight:400}
.interests input{width:auto!important}
#inquiry .invalid{border-color:#c0392b}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.submit-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
#inquiry-status{margin:0;font-size:14px;color:var(--ink-2)}
.campaign{background:var(--ink);color:var(--bg);border-radius:24px;padding:56px clamp(24px,5vw,64px);border:0}
.campaign h2{max-width:22ch}
.campaign p{color:color-mix(in srgb,var(--bg) 78%,transparent);max-width:60ch;font-size:17px}
.campaign .btn.primary{background:var(--gold);border-color:var(--gold);color:#16140f}
.campaign .small{font-size:14px;margin-top:18px}
footer{padding:40px 0 56px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}
</style>
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="#top"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 28 12 16 29 4 12Z" fill="#c9a45c"/><path d="M4 12h24M16 3l-5 9 5 17 5-17-5-9" fill="none" stroke="#16140f" stroke-opacity=".35" stroke-width="1.2"/></svg>KaratOS</a>
  <nav><a href="#how">How it works</a><a href="#departments">Departments</a><a href="#integrations">Integrations</a><a href="#services">Pricing</a><a href="#broken">Tell us what's broken</a></nav>
  <a class="btn primary small" href="#services">Custom services</a>
</div></header>

<main id="top">
<div class="wrap hero">
  <span class="eyebrow">For jewelers, wholesalers and manufacturers</span>
  <h1>The operating brain for jewelry businesses.</h1>
  <p class="lede">KaratOS connects the systems your business already runs, from the POS and the books to diamond feeds and the repair bench, and turns them into a short list of things to act on today. Every suggestion shows the evidence behind it.</p>
  <div class="actions"><a class="btn primary" href="#services">Custom services</a><a class="btn ghost" href="#integrations">See the integrations</a></div>
  <p class="note">Early access. The first integrations are being built and tested now.</p>
</div>

<section id="how"><div class="wrap">
  <h2>From scattered systems to a clear next step.</h2>
  <p class="section-intro">Most jewelry businesses run a dozen systems that don't talk to each other. KaratOS reads them all, connects what happens in one department to the next, and tells you what matters.</p>
  <ol class="steps">
    <li><h3>Connect, read-only</h3><p>Link your POS, store, books, bank statements (CSV or PDF), suppliers and feeds. Every connection starts read-only and lives in accounts you own.</p></li>
    <li><h3>Understand across departments</h3><p>A sale, a late repair, a stone on memo and a jump in gold all become signals, and each department sees what the others are doing.</p></li>
    <li><h3>Act with the evidence</h3><p>Each morning, a short list: what to do, why, and the records behind it. Accept, snooze or dismiss, and it learns what helps.</p></li>
  </ol>
  <div class="example">
    <span class="tag">Example</span>
    <p><strong>Call the Hendersons today.</strong> Their anniversary is in 9 days, they bought a band here three years ago, and the matching earrings came back in stock this week.</p>
    <p class="why">Why: based on 4 events from clienteling, sales and inventory. Illustrative.</p>
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

<section id="your-data"><div class="wrap">
  <h2>Your instance. Your data.</h2>
  <p class="section-intro">KaratOS runs as a private instance in accounts your business owns. We set it up, hand it over, and step away.</p>
  <div class="pillars">
    <div><h3>No one else sees it</h3><p>Once setup is done we have no access. Sales, customers, statements and margins never leave your own accounts.</p></div>
    <div><h3>Nothing shared by default</h3><p>Your data is never used to price, benchmark or advise another business unless you both opt in.</p></div>
    <div><h3>You decide when we come back</h3><p>Maintenance is optional. Sign up and we keep your instance current and add the integrations you need. Don't, and it keeps running on its own.</p></div>
  </div>
</div></section>

<section id="services"><div class="wrap">
  <span class="eyebrow">Custom services</span>
  <h2>We build it, connect it and keep it running.</h2>
  <p class="section-intro">Start with the Brain Console on its own, or have us connect the systems you run, build the ones nobody else will, and look after your instance.</p>
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
        <li><strong>Private by design.</strong> It runs on your own instance. We can't see your numbers unless you sign up for maintenance.</li>
      </ul>
    </div>
  </div>
  <ul class="plans">
    <li class="plan featured">
      <h3>Brain Console</h3>
      <p class="price"><strong>${CONSOLE_PRICE}</strong> per user per month</p>
      <p>Access to the dashboard itself, for each person on your team. It runs on a KaratOS instance you already have.</p>
      <p class="fine">Setting up the instance and connecting your systems isn't included; we quote that as a custom service.</p>
      <a class="btn primary" href="${CONTACT_ANCHOR}" data-interest="brain_console">Get the Brain Console</a>
    </li>
    <li class="plan">
      <h3>Maintenance</h3>
      <p class="price"><strong>By quote</strong></p>
      <p>We keep your instance current, watch every sync, fix connections when a vendor changes something and add integrations as your stack grows.</p>
      <a class="btn ghost" href="${CONTACT_ANCHOR}" data-interest="maintenance">Ask for a quote</a>
    </li>
    <li class="plan">
      <h3>Custom services</h3>
      <p class="price"><strong>By quote</strong></p>
      <p>Setting up your private instance, connecting your systems, integrations no one else builds, custom workflows and reports, and moving years of history out of old systems.</p>
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
        <label><input type="checkbox" name="interests" value="brain_console"> Brain Console</label>
        <label><input type="checkbox" name="interests" value="maintenance"> Maintenance</label>
        <label><input type="checkbox" name="interests" value="custom_services"> Custom services</label>
      </fieldset>
      <div class="row">
        <label>Your name<input name="name" autocomplete="name" maxlength="120" required></label>
        <label>Email<input name="email" type="email" autocomplete="email" maxlength="200" required></label>
      </div>
      <div class="row">
        <label>Business<input name="business" autocomplete="organization" maxlength="160" required></label>
        <label>Kind of business<select name="businessType" required><option value="">Choose one</option><option value="retail">Retail store</option><option value="wholesale">Wholesaler or diamond dealer</option><option value="manufacturing">Manufacturer</option><option value="other">Other</option></select></label>
      </div>
      <label class="seats">People who'd use the dashboard<input name="seats" type="number" min="1" max="10000" inputmode="numeric"></label>
      <label>What do you need?<textarea name="message" rows="5" maxlength="4000" required placeholder="The systems you run, what isn't working, and what you'd like built."></textarea></label>
      <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <div class="submit-row"><button class="btn primary" type="submit">Send</button><p id="inquiry-status" role="status" aria-live="polite"></p></div>
    </form>
  </div>
</div></section>

<section id="broken" style="border-top:0"><div class="wrap">
  <div class="campaign">
    <span class="eyebrow">Open call</span>
    <h2>Is a system in your jewelry business broken? Tell us.</h2>
    <p>The POS that won't export, the feed that lists a sold stone, the memo tracked on paper, the statements retyped every month. If something in your stack doesn't work, or doesn't talk to the rest, we want to hear about it and build around it.</p>
    <div class="actions"><a class="btn primary" href="${REPORT_URL}">Tell us what's broken</a></div>
    <p class="small">The form is public, so please leave out passwords, customer names and figures. A private form is on the way.</p>
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
    ['name','email','business','businessType','seats','message','website'].forEach(function(k){data[k]=form.elements[k].value});
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
  console.log(`wrote ${fileURLToPath(new URL("index.html", out))}`);
}
