# KaratOS website: a static page generated from the integration catalog.
# Build from the repo root: docker build -f site/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/retail/package.json packages/retail/
COPY packages/server/package.json packages/server/
RUN npm ci --ignore-scripts
COPY packages packages
COPY site site
RUN npm run build -w @karatos/core && node --import tsx site/build.ts

FROM caddy:2.10-alpine
COPY site/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/site/dist /srv
EXPOSE 8080
