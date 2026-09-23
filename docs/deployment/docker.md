# Docker deployment

The image contains Bun 1.4.2, the bundled server, Dashboard assets, and SQL migrations. It has one non-root process, one HTTP port, and one persistent `/data` volume. Put a TLS reverse proxy in front of it; Dashboard session cookies are always `Secure`.

## Pull and start

No origin, proxy, or upstream-host environment allowlist is required:

```sh
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

Compose uses `ghcr.io/baranwang/oh-my-emby:latest` by default. Select another published tag with `IMAGE_TAG` or another registry mirror with `IMAGE_REPOSITORY`.

For a local image, the multi-stage Dockerfile uses `turbo prune` for the server and Dashboard workspaces, installs each pruned lockfile, and builds each target independently:

```sh
docker build -t oh-my-emby:local .
IMAGE_REPOSITORY=oh-my-emby IMAGE_TAG=local docker compose up -d
```

The reverse proxy must preserve the public `Host` and enforce HTTPS. Dashboard mutations compare the browser's `Origin` with that `Host`, including its port; the application ignores all `X-Forwarded-*` headers. TLS termination is required for browsers to return the Dashboard's `Secure` session cookie. Plain HTTP is for loopback localhost development only. Publish a different host port if needed; keep the container listener on port 3000.

The process applies every pending migration before opening port 3000. A migration failure exits without listening. The SQLite database and the 256 MiB disk resource cache live under `/data` and survive container replacement.

## Private upstreams

Docker can reach any HTTP or HTTPS address an administrator saves for an Emby server, including LAN addresses and localhost. Choose addresses you trust: connection tests, authentication, and library sync will make server-side requests to them. Authenticated control redirects stay on that saved endpoint's exact origin.

Bun's standard outbound `fetch` does not expose or pin the actual connected destination address on every redirect hop. Until a peer-validating transport is available, server-side image/subtitle delivery fails closed; playback remains redirect-only and video bytes are never proxied or transcoded.

## Backup and upgrade

Stop the service before copying `/data` so the SQLite database, WAL, and cache are consistent:

```sh
docker compose stop oh-my-emby
docker compose run --rm --no-deps -T --entrypoint tar oh-my-emby \
  -C /data -czf - . > oh-my-emby-data.tgz
docker compose start oh-my-emby
```

Before an upgrade, take the backup, build the new image, remove the stopped container, and recreate it with the same volume. Startup migrations finish before the replacement listener becomes available. Restore only while the service is stopped.

## Runtime smoke

After building the verification image, run the isolated smoke. It creates uniquely named temporary container, network, and volume resources and removes only those resources on exit.

```sh
docker build -t oh-my-emby:verify .
./scripts/smoke-docker.sh
```
