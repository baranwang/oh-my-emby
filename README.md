<p align="center">
  <img src="assets/brand/logo.svg" alt="OhMyEmby logo" width="96" height="96">
</p>

# OhMyEmby

OhMyEmby is a self-hosted, Emby-compatible virtual server. Connect up to ten Emby servers, select their libraries, and browse matching titles as one item with multiple selectable media versions.

> This is an early MVP. Automated protocol and deployment checks exist, but real media-client playback and a remote Cloudflare deployment have not yet been verified. See the [SenPlayer compatibility evidence](docs/compatibility/senplayer.md).

## What it does

- Configure multiple Emby servers, each with ordered connection addresses, credentials, and a User-Agent policy. Read requests can try another verified address when a line fails.
- Merge movies, series, and episodes only when compatible external IDs or episode identities prove they are the same item. Unidentified items remain separate; matching copies appear as selectable versions.
- Keep one local user's watched, favorite, and resume state, then propagate writes to matching upstream items asynchronously.
- Optionally enrich titles and artwork from TMDB and Trakt, with upstream Emby metadata as the final fallback.
- Redirect video playback to the selected upstream source. OhMyEmby does not proxy or transcode video bytes, so the playback client must be able to reach the redirected URL.

Catalog requests are federated on demand and cached; the app does not crawl every upstream library in the background. One deployment exposes one virtual Emby server and one local user. Deploy separate instances for separate groups or users.

## Docker quick start

From a checkout of this repository:

```sh
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

Compose uses `ghcr.io/baranwang/oh-my-emby:latest` and stores SQLite data in a named volume. If you want to use the current checkout before its image is published, build it locally:

```sh
docker build -t oh-my-emby:local .
IMAGE_REPOSITORY=oh-my-emby IMAGE_TAG=local docker compose up -d
```

> The first visitor to an uninitialized instance can become its owner. Keep access restricted until you create your account.

The container is bound to `127.0.0.1:3000`. For access from another device, put an HTTPS reverse proxy in front of it and preserve the public `Host` header; browser sessions use `Secure` cookies. No public-origin, proxy, or upstream-host allowlist environment variables are required. Docker can connect to administrator-configured LAN addresses; `localhost` inside the container means the container itself, not the Docker host. See [Docker deployment](docs/deployment/docker.md) for backup and upgrade instructions.

Open `https://your-domain/dashboard` and:

1. Create the local owner account on first visit.
2. Add an Emby server and its connection address(es). Saving tests the connection and loads its source-library list; if discovery fails, the saved server remains available for retry.
3. Create a virtual library from the source libraries you want to expose. TMDB and Trakt can be configured later under System.
4. Add `https://your-domain` (without `/dashboard`) as a server in an Emby-compatible client, using the local owner credentials.

Video redirects can expose an upstream URL to the client. If that URL is private or requires headers the client cannot send, playback may not work from that client. Images and subtitles can also be unavailable when no safe client-accessible URL exists. Upstream credentials are retained for unattended access, so protect the SQLite volume or D1 database as part of your deployment.

## Cloudflare Workers

The alternative deployment uses Workers, D1, Static Assets, and a five-minute Cron trigger. Follow the [Workers deployment guide](docs/deployment/workers.md) to create the D1 binding, apply migrations, and deploy. Workers cannot connect to private, localhost, or IP-literal upstream addresses; use Docker for those servers.

## Development and verification

Development requires Bun 1.4.2. Docker users do not need Bun installed on the host.

```sh
bun ci
bun run check
bun --filter @oh-my-emby/server test:workers
./scripts/smoke-workers.sh
```

Docker build and smoke require a running Docker daemon:

```sh
docker build -t oh-my-emby:verify .
./scripts/smoke-docker.sh
```

The local Workers smoke uses workerd and local D1; it does not deploy to Cloudflare. Remote compatibility and runtime measurements are tracked in [runtime evidence](docs/compatibility/runtime.md). The Dashboard is at `/dashboard`; Emby-compatible routes are available at the origin root and under `/emby`.

## License

[AGPL-3.0](LICENSE)
