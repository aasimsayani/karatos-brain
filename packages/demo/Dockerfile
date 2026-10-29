# The demo store behind karatos.app/demo: made-up data through the real connectors and brain, in memory.
# Build from the repo root: docker build -f packages/demo/Dockerfile .
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/retail/package.json packages/retail/
COPY packages/server/package.json packages/server/
COPY packages/testkit/package.json packages/testkit/
COPY packages/connectors/package.json packages/connectors/
COPY packages/demo/package.json packages/demo/
RUN npm ci --ignore-scripts
COPY packages packages
RUN npm run build -w @karatos/core -w @karatos/store-postgres \
 && npm run build -w @karatos/retail -w @karatos/connector-testkit -w @karatos/connectors \
 && npm run build -w @karatos/server \
 && npm run build -w @karatos/demo \
 && npm prune --omit=dev --omit=optional

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages packages
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
CMD ["node", "packages/demo/dist/main.js"]
