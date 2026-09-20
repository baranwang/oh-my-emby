# Cloudflare Workers deployment

The Worker uses Static Assets, D1, and a five-minute Cron trigger. Playback is redirect-only; the Worker does not proxy or transcode video. Standard Workers `fetch` cannot expose and pin every connected peer address, so server-delivered images/subtitles fail closed when a safe direct client URL is unavailable.

## Create and configure

Use Bun 1.4.2 and the checked-in Wrangler 4 dependency:

```sh
bun ci
bun run build
apps/server/node_modules/.bin/wrangler --cwd apps/server d1 create oh-my-emby --binding DB --update-config
```

Set `vars.PUBLIC_ORIGIN` in `apps/server/wrangler.jsonc` to the exact public HTTPS origin. Do not include a path, query, credentials, or trailing slash. `TRUSTED_PROXIES` is a comma-separated allowlist; keep it empty unless a known proxy supplies forwarded headers. Custom upstream and public HTTPS ports are supported when the exact origin includes the port.

The D1 binding must remain `DB`, Static Assets binding `ASSETS`, assets directory `../dashboard/dist`, migrations directory `migrations`, and Cron `*/5 * * * *`. The committed config intentionally contains neither a production origin nor a D1 database ID.

Store future sensitive settings with Wrangler rather than in config:

```sh
apps/server/node_modules/.bin/wrangler --cwd apps/server secret put NAME
```

## Migrate, validate, deploy

Apply remote migrations before activating code that depends on them:

```sh
apps/server/node_modules/.bin/wrangler --cwd apps/server d1 migrations apply DB --remote
apps/server/node_modules/.bin/wrangler --cwd apps/server deploy --dry-run --outdir ../../.wrangler-dry-run
apps/server/node_modules/.bin/wrangler --cwd apps/server deploy
```

A migration failure must stop the release before deploy. The service accepts public upstream HTTPS hosts. Workers rejects private/local/IP-literal upstream destinations; use the Docker target for explicitly trusted LAN upstreams.

## Staging smoke

The default smoke is local and has no Cloudflare side effects:

```sh
./scripts/smoke-workers.sh
```

Remote release evidence requires an explicit staging-looking Worker name and exact HTTPS origin:

```sh
WORKERS_STAGING_NAME=oh-my-emby-staging \
WORKERS_STAGING_ORIGIN=https://oh-my-emby-staging.example.workers.dev \
./scripts/smoke-workers.sh --remote
```

Remote mode creates a uniquely named ephemeral D1 database, writes its returned ID into a temporary config, migrates D1 before deployment, checks health/assets/non-HTML misses/claim/session, and removes only that staging Worker and database on exit. Never point these variables at production.
