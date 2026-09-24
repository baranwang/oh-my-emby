# Cloudflare Workers deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/baranwang/oh-my-emby)

Click the button, sign in to Cloudflare, and authorize GitHub or GitLab. Cloudflare clones this public repository into your account, creates the D1 database, builds the app, and deploys it. Later pushes to your copy deploy automatically.

On the setup page, keep the root directory at the repository root. Accept these commands:

```sh
bun install --frozen-lockfile
bun --filter @oh-my-emby/server deploy
```

The deploy script applies D1 migrations and then deploys. If migrations fail, the new version is not deployed. Do not create the database yourself or write its ID into the repository. The binding name must stay `DB`.

No API key or public-origin variable is required. The first visitor to an uninitialized deployment can become its owner, so keep the address private until you create the account. Then open `/dashboard`.

The Worker serves the Dashboard from Static Assets and runs maintenance every five minutes. Playback is redirect-only. Workers cannot connect to private, localhost, or IP-literal upstream addresses; use Docker for those servers. Bind your own domain for production. The default `workers.dev` address is blocked in some regions.

Maintainers can still validate a build without publishing it:

```sh
bun ci
bun run build
apps/server/node_modules/.bin/wrangler --cwd apps/server deploy --dry-run --outdir ../../.wrangler-dry-run
```
