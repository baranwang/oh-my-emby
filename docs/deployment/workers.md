# Cloudflare Workers deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/baranwang/oh-my-emby)

The button only scans the repository root. This Worker lives in `apps/server`, so the button cannot provision it automatically. Use the button to connect the repository, then set the Workers Builds root directory to `apps/server`.

Use these commands. They run from `apps/server`, while installation and the application build run from the repository root:

```sh
cd ../.. && bun install --frozen-lockfile && bun run build
bun run deploy
bun run preview
```

`deploy` applies the D1 migrations and then publishes. If migrations fail, the new version is not deployed. `preview` uploads a version without promoting it. Do not create the database yourself or commit its ID. The binding name must stay `DB`.

No API key or public-origin variable is required. The first visitor to an uninitialized deployment can become its owner, so keep the address private until you create the account. Then open `/dashboard`.

The Worker serves the Dashboard from Static Assets and runs maintenance every five minutes. Playback is redirect-only. Workers cannot connect to private, localhost, or IP-literal upstream addresses; use Docker for those servers. Bind your own domain for production. The default `workers.dev` address is blocked in some regions.

Maintainers can still validate a build without publishing it:

```sh
bun ci
bun run build
apps/server/node_modules/.bin/wrangler --cwd apps/server deploy --dry-run --outdir ../../.wrangler-dry-run
```
