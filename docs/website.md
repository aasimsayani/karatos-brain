# KaratOS website

The public site lives in [`site/`](../site). `site/build.ts` renders one static page, and the integration directory and department list are generated from `packages/core/src/integrations.ts` and `@karatos/retail`, so the site always matches the catalog. Built connectors show a "Connector built" label and their `capabilities`, the plain-language list of what a business gets once that system is connected, and the hero names every built connector. Tests in `site/test` check every integration and department appears and that no client is named.

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

## Broken-systems campaign

"Is a system in your jewelry business broken? Tell us." sends people to the same private form with "Reporting a broken system" ticked, plus an optional field naming the system. Those issues are titled `Broken system: <system>` and labelled `broken-system` as well as `inquiry`. The public [integration request form](../.github/ISSUE_TEMPLATE/integration-request.yml) stays as the alternative for people happy to post in the open. Each report is triaged within a week into a catalog change, a vote on an existing entry, or a partnership ask; the triage steps and outreach copy live in the private commercial runbook.

## What each connection is worth

The "Value" section has one card per catalog domain that has data sources: the question that kind of system answers for the owner, why it matters, and which systems are connected today (or being built now, or how many are on the roadmap). Domains with a built system come first. The copy lives in `DOMAIN_VALUE`; a new domain with data sources stops the build until it has an entry, so the page never shows a kind of system without saying what it is worth.

## Holiday pilot

The "Holiday pilot" section announces the testing weekend before Black Friday. Its dates live in `HOLIDAY_PILOT` (`weekend` and `signupsOpen`), so moving the weekend is a one-line change. "Join the pilot" and the hero's primary button send people to the private form with "Holiday pilot" ticked. Pilot sign-ups are titled `Holiday pilot: <business>` when nothing else is ticked, and labelled `pilot` as well as `inquiry`.

## Deploy

The site runs on Railway as its own project, separate from any client instance. The service builds `site/Dockerfile` from the repo root (set `RAILWAY_DOCKERFILE_PATH=site/Dockerfile` on the service) and runs `node site/server.ts` on `$PORT` (Node strips the types; the server has no dependencies). A push to the deployed branch redeploys it.
