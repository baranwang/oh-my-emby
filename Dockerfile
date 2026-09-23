FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY assets assets
RUN bun run build

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ASSETS_DIR=/app/apps/dashboard/dist \
    MIGRATIONS_DIR=/app/apps/server/migrations

COPY --from=build --chown=bun:bun /app/apps/server/dist/bun/index.js /app/apps/server/dist/bun/index.js
COPY --from=build --chown=bun:bun /app/apps/dashboard/dist /app/apps/dashboard/dist
COPY --from=build --chown=bun:bun /app/apps/server/migrations /app/apps/server/migrations
RUN rm /usr/local/bun-node-fallback-bin/node && \
    mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/health');process.exit(r.ok?0:1)"]
CMD ["bun", "/app/apps/server/dist/bun/index.js"]
