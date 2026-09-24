FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /app

FROM base AS pruner
COPY . .
RUN bunx turbo@2.11.2 prune @oh-my-emby/server --docker --out-dir=/out/server \
  && bunx turbo@2.11.2 prune @oh-my-emby/dashboard --docker --out-dir=/out/dashboard

FROM base AS server-installer
COPY --from=pruner /out/server/json/ .
COPY --from=pruner /out/server/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

FROM base AS server-builder
COPY --from=pruner /out/server/full/ .
COPY --from=server-installer /app/ .
COPY tsconfig.base.json ./tsconfig.base.json
RUN bun run build --filter=@oh-my-emby/server

FROM base AS dashboard-installer
COPY --from=pruner /out/dashboard/json/ .
COPY --from=pruner /out/dashboard/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

FROM base AS dashboard-builder
COPY --from=pruner /out/dashboard/full/ .
COPY --from=dashboard-installer /app/ .
COPY tsconfig.base.json ./tsconfig.base.json
COPY assets ./assets
RUN bun run build --filter=@oh-my-emby/dashboard

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ASSETS_DIR=/app/apps/dashboard/dist \
    MIGRATIONS_DIR=/app/apps/server/migrations

COPY --from=server-builder --chown=bun:bun /app/apps/server/dist/bun/index.js /app/apps/server/dist/bun/index.js
COPY --from=dashboard-builder --chown=bun:bun /app/apps/dashboard/dist /app/apps/dashboard/dist
COPY --from=server-builder --chown=bun:bun /app/apps/server/migrations /app/apps/server/migrations
RUN rm /usr/local/bun-node-fallback-bin/node && \
    mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/health');process.exit(r.ok?0:1)"]
CMD ["bun", "/app/apps/server/dist/bun/index.js"]
