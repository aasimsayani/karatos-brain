# KaratOS website

The public site lives in [`site/`](../site). `site/build.ts` renders one static page, and the integration directory and department list are generated from `packages/core/src/integrations.ts` and `@karatos/retail`, so the site always matches the catalog. Tests in `site/test` check every integration and department appears and that no client is named.

## Build and preview

```sh
node --import tsx site/build.ts   # writes site/dist/index.html
node site/server.ts                # serves it on :8080
```

## Inquiry form

Quote and Brain Console requests use a private form on the page. `site/server.ts` serves the page and accepts `POST /api/inquiry`: it validates the fields, drops bot submissions (a hidden field), limits each address to five inquiries an hour and files each one as an issue labelled `inquiry` in a private GitHub repository. Visitor text is fenced in the issue so it renders as plain text. Nothing is posted publicly.

| Variable | What it is |
| --- | --- |
| `INQUIRY_REPO` | `owner/name` of the private repository that receives inquiries |
| `INQUIRY_GITHUB_TOKEN` | Fine-grained token with Issues read and write on that repository only |

Without both, the form answers that it isn't connected yet and the rest of the site works normally.

## Deploy

The site runs on Railway as its own project, separate from any client instance. The service builds `site/Dockerfile` from the repo root (set `RAILWAY_DOCKERFILE_PATH=site/Dockerfile` on the service) and runs `node site/server.ts` on `$PORT` (Node strips the types; the server has no dependencies). A push to the deployed branch redeploys it.
