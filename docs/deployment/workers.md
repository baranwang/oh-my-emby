# Cloudflare Workers deployment

The Worker uses Static Assets, D1, and a five-minute Cron trigger. Playback is redirect-only; the Worker does not proxy or transcode video. Standard Workers `fetch` cannot expose and pin every connected peer address, so server-delivered images/subtitles fail closed when a safe direct client URL is unavailable.

## Create and configure

Use Bun 1.4.2 and the checked-in Wrangler 4 dependency:

```sh
bun ci
bun run build
apps/server/node_modules/.bin/wrangler --cwd apps/server d1 create oh-my-emby --binding DB --update-config
```

No public-origin or trusted-proxy variable is needed. Dashboard mutations compare the browser's `Origin` with the request `Host`, including its port, and ignore `X-Forwarded-*`. Use public HTTPS for production; loopback HTTP is only for local development. Custom public HTTPS ports work without extra configuration.

The D1 binding must remain `DB`, Static Assets binding `ASSETS`, assets directory `../dashboard/dist`, migrations directory `migrations`, and Cron `*/5 * * * *`. The committed config intentionally contains no D1 database ID.

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

A migration failure must stop the release before deploy. The service accepts public upstream HTTPS hosts. Workers cannot fetch private/local/IP-literal upstream destinations; use Docker for LAN upstreams.

## Staging smoke

The default smoke is local and has no Cloudflare side effects:

```sh
./scripts/smoke-workers.sh
```

Inspect the remote plan without creating local temporary state or contacting Cloudflare:

```sh
./scripts/smoke-workers.sh --plan-remote
```

Run the remote smoke only from an authenticated release environment:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
./scripts/smoke-workers.sh --remote
```

Remote mode generates one 128-bit run ID and derives the exact ephemeral Worker and D1 names from it. Caller-supplied Worker names and origins are not accepted. Before creating D1 or invoking deploy, the script authenticates to the exact Workers Script API resource and continues only for a Cloudflare `404` with error code `10007`; an existing script or any ambiguous response stops the run.

The first deployment is a token-protected ownership probe. The script parses the run-owned `workers.dev` URL from Wrangler output, calls that exact origin, and requires the exact run ID plus `private, no-store`. Only then is the Worker eligible for automatic deletion. A failed deploy or ownership check prints the generated Worker name for manual inspection and deliberately does not delete it. D1 cleanup uses only the validated UUID returned by creation, never a name lookup. Loopback API/Wrangler overrides exist solely for the local integration test and reject non-loopback endpoints.

After ownership is proven, the script replaces the probe with the application, migrates D1 before application deployment, and checks health/assets/non-HTML misses/claim/session.

The same run then temporarily replaces that Worker with an authenticated single-derivation PBKDF2 entrypoint. A local Bun runner sends ten requests, discards the first timing, and gates the remaining end-to-end request samples at p95 below 250 ms. This caller-side timing is required because [deployed Workers timers do not advance during CPU-only execution](https://developers.cloudflare.com/workers/runtime-apis/performance/). Cleanup deletes only the ownership-verified Worker name and the exact D1 creation UUID. The command still has remote side effects and must not run against a production release path.
