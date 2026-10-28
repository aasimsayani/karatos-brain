# KaratOS website: a static page generated from the integration catalog,
# plus a small dependency-free server for the private inquiry form.
# Build from the repo root: docker build -f site/Dockerfile .
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/connectors/package.json packages/connectors/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/retail/package.json packages/retail/
COPY packages/server/package.json packages/server/
COPY packages/testkit/package.json packages/testkit/
RUN npm ci --ignore-scripts
COPY packages packages
COPY site site
RUN npm run build -w @karatos/core && node --import tsx site/build.ts

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /srv
COPY --from=build /app/site/server.ts site/server.ts
COPY --from=build /app/site/dist site/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
CMD ["node", "site/server.ts"]
