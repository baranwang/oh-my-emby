# Docker deployment

The image contains Bun 1.4.2, the bundled server, Dashboard assets, and SQL migrations. It has one non-root process, one HTTP port, and one persistent `/data` volume. Put a TLS reverse proxy in front of it; Dashboard session cookies are always `Secure`.

## Pull and start

Set the exact public origin and the socket addresses of proxies that may supply forwarded headers:

```sh
export PUBLIC_ORIGIN=https://emby.example.com
export TRUSTED_PROXIES=172.18.0.2
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

Use an explicitly empty `TRUSTED_PROXIES` value when there is no reverse proxy. Only addresses in this comma-separated allowlist can affect `X-Forwarded-*` handling. `PUBLIC_ORIGIN` must be an exact HTTPS origin; plain HTTP is accepted only for `localhost` and only from a loopback socket.

The reverse proxy must preserve the public `Host`, set `X-Forwarded-Proto: https`, and connect from an address in `TRUSTED_PROXIES`. TLS termination is required for browsers to return the Dashboard's `Secure` session cookie. Publish a different host port if needed; keep the container listener on port 3000.

The process applies every pending migration before opening port 3000. A migration failure exits without listening. The SQLite database and the 256 MiB disk resource cache live under `/data` and survive container replacement.

## Private upstreams

Private control-plane destinations are disabled unless their exact hostname or IP is listed in `PRIVATE_UPSTREAM_HOSTS`. Redirects for a private upstream remain confined to the exact administrator-configured origin.

For LAN upstreams, trust only administrator-controlled exact hostnames or IPs. Do not use a broad subnet or wildcard. A proxy-facing trust entry and a LAN-upstream trust entry solve different problems: `TRUSTED_PROXIES` authorizes forwarded headers, while `PRIVATE_UPSTREAM_HOSTS` authorizes control-plane access to a private upstream.

Bun's standard outbound `fetch` does not expose or pin the actual connected destination address on every redirect hop. Until a peer-validating transport is available, server-side image/subtitle delivery fails closed; playback remains redirect-only and video bytes are never proxied or transcoded.

## Backup and upgrade

Stop the service before copying `/data` so the SQLite database, WAL, and cache are consistent:

```sh
docker compose stop oh-my-emby
docker compose run --rm --no-deps -T --entrypoint tar oh-my-emby \
  -C /data -czf - . > oh-my-emby-data.tgz
docker compose start oh-my-emby
```

Before an upgrade, take the backup, build the new image, remove the stopped container, and recreate it with the same volume and environment. Startup migrations finish before the replacement listener becomes available. Restore only while the service is stopped.

## Runtime smoke

After building the verification image, run the isolated smoke. It creates uniquely named temporary container, network, and volume resources and removes only those resources on exit.

```sh
docker build -t oh-my-emby:verify .
./scripts/smoke-docker.sh
```
