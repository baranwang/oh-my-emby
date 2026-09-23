# oh-my-emby

An open-source Emby-compatible virtual server that aggregates up to ten upstream servers into one exact-ID catalog. It keeps user state locally and sends playback as private `302` redirects: it never proxies or transcodes video bytes.

## Requirements

- Bun 1.4.2
- Docker, for the Docker image and runtime smoke
- A Cloudflare account, only for an optional Workers deployment

## Local gates

```sh
bun ci
bun run check
bun --filter @oh-my-emby/server test:workers
bun --filter @oh-my-emby/server test:bun
./scripts/smoke-workers.sh
docker build -t oh-my-emby:verify .
./scripts/smoke-docker.sh
bun scripts/benchmark-pbkdf2.ts
```

The Workers smoke defaults to local workerd and local D1. Remote staging requires both `--remote` and explicit staging-only environment values; CI never deploys remote resources.

## Deploy

- [Cloudflare Workers](docs/deployment/workers.md)
- [Docker](docs/deployment/docker.md)
- [Runtime compatibility](docs/compatibility/runtime.md)
- [SenPlayer evidence](docs/compatibility/senplayer.md)

The Compose file pulls `ghcr.io/baranwang/oh-my-emby:latest` by default:

```sh
docker compose pull
docker compose up -d
```

To run a locally built image, build the Dockerfile and set its tag explicitly:

```sh
docker build -t oh-my-emby:local .
IMAGE_REPOSITORY=oh-my-emby IMAGE_TAG=local docker compose up -d
```

The Dashboard is served at `/dashboard`. Public Emby-compatible endpoints accept both root routes and their `/emby` aliases.
