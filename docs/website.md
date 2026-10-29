# KaratOS website

The public site lives in [`site/`](../site). `site/build.ts` renders one static page, and the integration directory and department list are generated from `packages/core/src/integrations.ts` and `@karatos/retail`, so the site always matches the catalog. Built connectors show a "Connector built" label and their `capabilities`, the plain-language list of what a business gets once that system is connected, and the hero names every built connector. Tests in `site/test` check every integration and department appears and that no client is named.

## The integration directory

The directory groups every system by category (the catalog domain), with the categories that have the most connected systems first. Each category is a folded group with its count and how many are connected, and only the first starts open: a closed group isn't laid out, which keeps the page quick as the catalog grows and makes links further down the page land where they point. A row of category links and a category filter sit above it. Search, filters and category links open the groups they match.

Every card carries one plain sentence on what KaratOS reads from the system, and the company behind it when that company makes several systems on the map ("By Google"). A Details panel adds how it connects, how much history is imported, whether updates arrive live, how it is tested, the departments it feeds, who uses it and what stage it is at. The sentence and company live in `SYSTEM_DETAILS` in [`site/directory.ts`](../site/directory.ts); the rest comes from the catalog. A test fails when a system joins the catalog without an entry, so every new system arrives with its details.

"Newest connections" shows the eight most recently connected systems. The day each connector landed on `main` lives in `CONNECTED_ON` in the same file, and a test fails until a newly built connector has one, so each release shows what it added. The hero's figures (systems connected, mapped and categories) and the Partners section's three stages (on the map, building now, connected) are counted from the catalog.

## Partners

"For partners" is written for the vendors whose systems we connect: why being read next to a jeweler's other systems makes their product harder to replace, how a system moves from the map to connected, and the three promises (read-only by default, no surprise writes, kept current by the docs watch and the nightly sandbox run). It links to the public integration request form and the private contact form.

## Systems together and write-back

Two sections follow "How it works":

- **Systems that work together** ("One system knows a little. Together they know what to do.") shows four to six plays from `PLAYS` in `site/build.ts`. Each is marked Illustrative, names the three or four catalog systems it combines by integration id, and ends in one result. System names are taken from the catalog, the build stops if a play names an id that isn't in `INTEGRATIONS`, and a test checks the same. Only name systems already in the catalog on `main`.
- **Write-back** ("Reads freely. Writes carefully.") lists `WRITE_RULES`: every connection starts read-only; writing back is off until the business turns it on per system and per action; drafts and additions are preferred over changes and nothing is deleted; a person approves each write; the record is re-checked right before writing; writes are capped per day, read back to confirm they landed, and can be undone; one mismatch stops all writes to that system until a person checks. It closes on the business's own systems staying the source of truth. A test checks each of these claims is on the page, so the copy can't quietly promise more or less; change it only alongside the write-back code.

The hero names watch dealers in its audience line and mentions careful write-back, and the nav links to both sections. Counts on the page, such as the number of systems mapped, come from the catalog, never a hard-coded number. Domain labels live in `DOMAIN_LABELS`; a new catalog domain still builds, and a test fails until it has a label.

## Build and preview

```sh
node --import tsx site/build.ts   # writes site/dist/index.html
node site/server.ts                # serves it on :8080
```

## Lighthouse

CI's `website-lighthouse` job builds the site, serves it, runs Lighthouse three times with its default mobile emulation, and fails if the median score for performance, accessibility, best practices or SEO is under 90 (`site/lighthouse.ts`). The median keeps one slow run on a busy shared runner from failing the site. A run where Chrome itself fails is retried once, and a run that fails twice counts as unscored. When the job fails, its annotations say why: the server didn't start, or which category missed the bar, with every run's score. To run it locally:

```sh
node site/server.ts &
npx lighthouse@12.8.2 http://127.0.0.1:8080/ --chrome-flags="--headless=new" --output=json --output-path=lighthouse.json
node site/lighthouse.ts lighthouse.json   # or several reports, judged on the median
```

Type is set in IBM Plex: Sans for words, Mono for labels, prices and figures. The four font files (latin subset, OFL) are copied from `@fontsource` into `site/dist/fonts/` at build time and served by the site itself under `/fonts/`, so the page makes no third-party requests and never swaps from one typeface to another. The two weights the first screen uses are preloaded. The server only serves file names it loaded from that folder at start-up, and returns 404 for anything else under `/fonts/`.

Spacing comes from one scale (`--space-1` to `--space-5`: 8, 16, 24, 32 and 48px). Every section and the hero are padded `--section` (64px on phones up to 96px) top and bottom, each section's heading, intro and content sit 16px and 48px apart, and any spacing written in pixels stays on a 4px grid. A test enforces all three.

Every response carries a strict `Content-Security-Policy` (the page's inline script and style are allowed only by hash), HSTS, `X-Frame-Options: DENY`, `nosniff` and same-origin opener and resource policies; [docs/security.md](security.md) lists them all. Keep the page free of inline `style=""` attributes and `on…=""` handlers, which the policy would block; a test checks. Another test pins the whole policy for the built page, recomputing both hashes, so a loosened directive or an extra inline script fails.

The page is served gzipped, and small gold or grey text uses the darker `--gold-text` and `--muted` colors so it stays at WCAG AA contrast.

## Inquiry form

Quote and Brain Console requests use a private form on the page. `site/server.ts` serves the page and accepts `POST /api/inquiry`: it validates the fields, drops bot submissions (a hidden field), limits each address to five inquiries an hour and files each one as an issue labelled `inquiry` in a private GitHub repository. Visitor text is fenced in the issue so it renders as plain text. Nothing is posted publicly.

| Variable | What it is |
| --- | --- |
| `INQUIRY_REPO` | `owner/name` of the private repository that receives inquiries |
| `INQUIRY_GITHUB_TOKEN` | Fine-grained token with Issues read and write on that repository only |

Without both, the form answers that it isn't connected yet and the rest of the site works normally. The repository needs the labels `inquiry`, `broken-system` and `pilot`.

## Live demo

The hero's "Try the live demo" button and the nav's "Demo" link open `/demo/`. The site passes everything under `/demo` to the demo console (the KaratOS console in demo mode, reading a demo store of made-up data; see [docs/demo.md](demo.md)), path and query unchanged, since the console serves under `BASE_PATH=/demo`. Host goes through as the visitor sent it, so the console's same-origin check sees `karatos.app`.

| Variable | What it is |
| --- | --- |
| `DEMO_CONSOLE_URL` | The demo console on Railway's private network, such as `http://demo-console.railway.internal:8080` |

Only plain `http://` to a `.railway.internal` host is taken (or `localhost` for local runs), so the console needs no public domain. Without it `/demo` answers 503 "The demo isn't running yet." and the rest of the site works normally; a console that is down or takes over 15 seconds gets a 502.

## Broken-systems campaign

"Is a system in your jewelry business broken? Tell us." sends people to the same private form with "Reporting a broken system" ticked, plus an optional field naming the system. Those issues are titled `Broken system: <system>` and labelled `broken-system` as well as `inquiry`. The public [integration request form](../.github/ISSUE_TEMPLATE/integration-request.yml) stays as the alternative for people happy to post in the open. Each report is triaged within a week into a catalog change, a vote on an existing entry, or a partnership ask; the triage steps and outreach copy live in the private commercial runbook.

## What each connection is worth

The "Value" section has one card per catalog domain that has data sources: the question that kind of system answers for the owner, why it matters, and which systems are connected today (or being built now, or how many are on the roadmap). Domains with a built system come first. The copy lives in `DOMAIN_VALUE`; a new domain with data sources stops the build until it has an entry, so the page never shows a kind of system without saying what it is worth.

## Holiday pilot

The "Holiday pilot" section announces the testing weekend before Black Friday. Its dates live in `HOLIDAY_PILOT` (`weekend` and `signupsOpen`), so moving the weekend is a one-line change. "Join the pilot" and the hero's primary button send people to the private form with "Holiday pilot" ticked. Pilot sign-ups are titled `Holiday pilot: <business>` when nothing else is ticked, and labelled `pilot` as well as `inquiry`.

## Deploy

The site runs on Railway as its own project, separate from any client instance. The service builds `site/Dockerfile` from the repo root (set `RAILWAY_DOCKERFILE_PATH=site/Dockerfile` on the service) and runs `node site/server.ts` on `$PORT` (Node strips the types; the server has no dependencies). A push to the deployed branch redeploys it.

A failed deploy leaves the old page up with no error, so two checks watch for it:

- CI's `website-docker` job builds `site/Dockerfile`, starts the container and checks that it serves the page main builds.
- The `Website freshness` workflow runs daily and after each green CI run on main. It compares the live page with a fresh build of main and opens one `site-freshness` issue while they differ, then closes it once they match. The run itself stays green, so a host that waits for green checks before deploying is never held back by it; CI's image check passes `--strict` to fail instead. The page carries two tags for this: `karatos-connected` (the ids of every built connector) and `karatos-mapped` (how many systems are on the map). The live URL comes from the `SITE_URL` repository variable, and defaults to https://karatos.app. Run it by hand with `SITE_URL=<url> npm run site:freshness -- --dry-run` after `node --import tsx site/build.ts`.

When the issue opens, read the latest deployment's build log on the website service in Railway, fix what it names, and redeploy from main.
