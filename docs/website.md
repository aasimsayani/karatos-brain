# KaratOS website

The public site lives in [`site/`](../site). `site/build.ts` renders one static page, and the integration directory and department list are generated from `packages/core/src/integrations.ts` and `@karatos/retail`, so the site always matches the catalog. Built connectors show a "Connector built" label and their `capabilities`, the plain-language list of what a business gets once that system is connected, and the hero names every built connector. Tests in `site/test` check every integration and department appears and that no client is named.

## Build and preview

```sh
node --import tsx site/build.ts   # writes site/dist/index.html
node site/server.ts                # serves it on :8080
```

## Lighthouse

CI's `website-lighthouse` job builds the site, serves it, runs Lighthouse three times with its default mobile emulation, and fails if the median score for performance, accessibility, best practices or SEO is under 90 (`site/lighthouse.ts`). The median keeps one slow run on a busy shared runner from failing the site. To run it locally:

```sh
node site/server.ts &
npx lighthouse@12.8.2 http://127.0.0.1:8080/ --chrome-flags="--headless=new" --output=json --output-path=lighthouse.json
node site/lighthouse.ts lighthouse.json   # or several reports, judged on the median
```

Type is set in IBM Plex: Sans for words, Mono for labels, prices and figures. The four font files (latin subset, OFL) are copied from `@fontsource` into `site/dist/fonts/` at build time and served by the site itself under `/fonts/`, so the page makes no third-party requests and never swaps from one typeface to another. The two weights the first screen uses are preloaded. The server only serves file names it loaded from that folder at start-up, and returns 404 for anything else under `/fonts/`.

The page is served gzipped, and small gold or grey text uses the darker `--gold-text` and `--muted` colors so it stays at WCAG AA contrast.

## Inquiry form

Quote and Brain Console requests use a private form on the page. `site/server.ts` serves the page and accepts `POST /api/inquiry`: it validates the fields, drops bot submissions (a hidden field), limits each address to five inquiries an hour and files each one as an issue labelled `inquiry` in a private GitHub repository. Visitor text is fenced in the issue so it renders as plain text. Nothing is posted publicly.

| Variable | What it is |
| --- | --- |
| `INQUIRY_REPO` | `owner/name` of the private repository that receives inquiries |
| `INQUIRY_GITHUB_TOKEN` | Fine-grained token with Issues read and write on that repository only |

Without both, the form answers that it isn't connected yet and the rest of the site works normally. The repository needs the labels `inquiry` and `broken-system`.

## Broken-systems campaign

"Is a system in your jewelry business broken? Tell us." sends people to the same private form with "Reporting a broken system" ticked, plus an optional field naming the system. Those issues are titled `Broken system: <system>` and labelled `broken-system` as well as `inquiry`. The public [integration request form](../.github/ISSUE_TEMPLATE/integration-request.yml) stays as the alternative for people happy to post in the open. Each report is triaged within a week into a catalog change, a vote on an existing entry, or a partnership ask; the triage steps and outreach copy live in the private commercial runbook.

## Deploy

The site runs on Railway as its own project, separate from any client instance. The service builds `site/Dockerfile` from the repo root (set `RAILWAY_DOCKERFILE_PATH=site/Dockerfile` on the service) and runs `node site/server.ts` on `$PORT` (Node strips the types; the server has no dependencies). A push to the deployed branch redeploys it.
