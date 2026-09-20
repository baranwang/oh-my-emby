# Docker deployment

The image contains Bun 1.4.2, the bundled server, Dashboard assets, and SQL migrations. It has one non-root process, one HTTP port, and one persistent `/data` volume. Put a TLS reverse proxy in front of it; Dashboard session cookies are always `Secure`.

## Configure and start

Set the exact public origin and the socket addresses of proxies that may supply forwarded headers:

```sh
export PUBLIC_ORIGIN=https://emby.example.com
export TRUSTED_PROXIES=172.18.0.2
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
```

Use an explicitly empty `TRUSTED_PROXIES` value when there is no reverse proxy. Only addresses in this comma-separated allowlist can affect `X-Forwarded-*` handling. `PUBLIC_ORIGIN` must be an exact HTTPS origin; plain HTTP is accepted only for `localhost` and only from a loopback socket.

The process applies every pending migration before opening port 3000. A migration failure exits without listening. The SQLite database and the 256 MiB disk resource cache live under `/data` and survive container replacement.

## Private upstreams

Private control-plane destinations are disabled unless their exact hostname or IP is listed in `PRIVATE_UPSTREAM_HOSTS`. Redirects for a private upstream remain confined to the exact administrator-configured origin.

Bun's standard outbound `fetch` does not expose or pin the actual connected destination address on every redirect hop. Until a peer-validating transport is available, server-side image/subtitle delivery fails closed; playback remains redirect-only and video bytes are never proxied or transcoded.

## Backup and upgrade

Stop the service before copying `/data` so the SQLite database, WAL, and cache are consistent:

```sh
docker compose stop
docker run --rm -v oh-my-emby_oh-my-emby-data:/data:ro -v "$PWD":/backup oven/bun:1.4.2-slim \
  sh -c 'tar -C /data -czf /backup/oh-my-emby-data.tgz .'
docker compose start
```

Before an upgrade, take the backup, pull or build the new image, then run `docker compose up -d`. Startup migrations finish before the replacement listener becomes available. Restore only while the service is stopped.
