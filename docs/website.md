# KaratOS website

The public site lives in [`site/`](../site). `site/build.ts` renders one static page, and the integration directory and department list are generated from `packages/core/src/integrations.ts` and `@karatos/retail`, so the site always matches the catalog. Tests in `site/test` check every integration and department appears and that no client is named.

## Build and preview

```sh
node --import tsx site/build.ts   # writes site/dist/index.html
```

## Deploy

The site runs on Railway as its own project, separate from any client instance. The service builds `site/Dockerfile` from the repo root (set `RAILWAY_DOCKERFILE_PATH=site/Dockerfile` on the service) and serves the page with Caddy on `$PORT`. A push to the deployed branch redeploys it.
