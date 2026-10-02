# Brain A instance image. One running container serves one client.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/server/package.json packages/server/
RUN npm ci --ignore-scripts
COPY packages packages
RUN npm run build -w @karatos/core -w @karatos/store-postgres -w @karatos/server \
 && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/store-postgres/package.json packages/store-postgres/
COPY --from=build /app/packages/store-postgres/dist packages/store-postgres/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY supabase/migrations supabase/migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
CMD ["node", "packages/server/dist/main.js"]
