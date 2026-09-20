#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
WRANGLER="$SERVER_DIR/node_modules/.bin/wrangler"
TEMP_DIR="$(mktemp -d)"
CONFIG="$TEMP_DIR/wrangler.json"
STATE_DIR="$TEMP_DIR/state"
LOG="$TEMP_DIR/wrangler.log"
MODE=local
DEV_PID=
REMOTE_DB=
REMOTE_WORKER_CREATED=0
REMOTE_DB_CREATED=0

if [[ "${1:-}" == "--remote" ]]; then
  MODE=remote
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--remote]" >&2
  exit 2
fi

cleanup() {
  local code=$?
  local cleanup_failed=0
  trap - EXIT INT TERM
  if [[ "$code" != 0 && -s "$LOG" ]]; then cat "$LOG" >&2; fi
  if [[ -n "$DEV_PID" ]]; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$REMOTE_WORKER_CREATED" == 1 ]]; then
    "$WRANGLER" --cwd "$SERVER_DIR" delete "$WORKERS_STAGING_NAME" --config "$CONFIG" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [[ "$REMOTE_DB_CREATED" == 1 ]]; then
    "$WRANGLER" --cwd "$SERVER_DIR" d1 delete "$REMOTE_DB" --skip-confirmation --config "$CONFIG" >/dev/null 2>&1 || cleanup_failed=1
  fi
  rm -rf "$TEMP_DIR"
  if [[ "$code" == 0 && "$cleanup_failed" == 1 ]]; then code=1; fi
  exit "$code"
}
trap cleanup EXIT INT TERM

write_config() {
  CONFIG_PATH="$CONFIG" CONFIG_NAME="$1" CONFIG_ORIGIN="$2" CONFIG_LOCAL_D1="$3" ROOT_PATH="$ROOT" bun -e '
      const localD1 = process.env.CONFIG_LOCAL_D1 === "1"
      const config = {
        name: process.env.CONFIG_NAME,
        main: `${process.env.ROOT_PATH}/apps/server/src/platform/workers/index.ts`,
        compatibility_date: "2026-09-20",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          PUBLIC_ORIGIN: process.env.CONFIG_ORIGIN,
          TRUSTED_PROXIES: ""
        },
        assets: {
          directory: `${process.env.ROOT_PATH}/apps/dashboard/dist`,
          binding: "ASSETS",
          html_handling: "none",
          not_found_handling: "none",
          run_worker_first: true
        },
        triggers: { crons: ["*/5 * * * *"] },
        observability: {
          enabled: true,
          head_sampling_rate: 1,
          redact_query_string: true
        },
        ...(localD1 ? {
          d1_databases: [{
            binding: "DB",
            database_name: "oh-my-emby-local-smoke",
            migrations_dir: `${process.env.ROOT_PATH}/apps/server/migrations`
          }]
        } : {})
      }
      await Bun.write(process.env.CONFIG_PATH, JSON.stringify(config, null, 2))
    '
}

smoke_http() {
  local base_url=$1
  local public_origin=$2
  local status
  local path
  local session_cookie

  status="$(curl --silent --show-error -o "$TEMP_DIR/body" -w '%{http_code}' "$base_url/health")"
  [[ "$status" == 200 ]]
  grep -q '"status":"ok"' "$TEMP_DIR/body"

  status="$(curl --silent --show-error -D "$TEMP_DIR/headers" -o "$TEMP_DIR/body" -w '%{http_code}' -H "Accept: text/html" "$base_url/dashboard/servers")"
  [[ "$status" == 200 ]]
  grep -qi '^content-type:.*text/html' "$TEMP_DIR/headers"

  for path in /api/dashboard/not-a-route /dashboard/assets/missing.js; do
    status="$(curl --silent --show-error -D "$TEMP_DIR/headers" -o "$TEMP_DIR/body" -w '%{http_code}' -H "Accept: text/html" "$base_url$path")"
    [[ "$status" == 404 ]]
    if grep -qi '^content-type:.*text/html' "$TEMP_DIR/headers"; then return 1; fi
  done

  status="$(curl --silent --show-error -D "$TEMP_DIR/headers" -o "$TEMP_DIR/body" -w '%{http_code}' -H "Origin: $public_origin" -H "Content-Type: application/json" --data '{"username":"owner","password":"valid password"}' "$base_url/api/dashboard/claim")"
  [[ "$status" == 200 ]]
  grep -q '"authenticated":true' "$TEMP_DIR/body"
  session_cookie="$(tr -d '\r' <"$TEMP_DIR/headers" | sed -n 's/^[Ss]et-[Cc]ookie:[[:space:]]*\([^;]*\).*/\1/p' | head -n 1)"
  [[ -n "$session_cookie" ]]

  status="$(curl --silent --show-error -o "$TEMP_DIR/body" -w '%{http_code}' -H "Cookie: $session_cookie" "$base_url/api/dashboard/session")"
  [[ "$status" == 200 ]]
  grep -q '"authenticated":true' "$TEMP_DIR/body"
  return 0
}

if [[ "$MODE" == local ]]; then
  PORT="$(bun -e 'const server=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(server.port);server.stop()')"
  ORIGIN="http://localhost:$PORT"
  write_config "oh-my-emby-local-smoke" "$ORIGIN" 1
  mkdir -p "$STATE_DIR"
  CI=1 "$WRANGLER" --cwd "$SERVER_DIR" d1 migrations apply DB --local --persist-to "$STATE_DIR" --config "$CONFIG"
  "$WRANGLER" --cwd "$SERVER_DIR" dev --local --ip 127.0.0.1 --port "$PORT" --persist-to "$STATE_DIR" --config "$CONFIG" --log-level warn --show-interactive-dev-session=false >"$LOG" 2>&1 &
  DEV_PID=$!
  for _ in {1..60}; do
    if curl --fail --silent --show-error "$ORIGIN/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$DEV_PID" >/dev/null 2>&1; then
      cat "$LOG"
      exit 1
    fi
    sleep 0.5
  done
  if ! curl --fail --silent --show-error "$ORIGIN/health" >/dev/null; then
    cat "$LOG"
    exit 1
  fi
  smoke_http "$ORIGIN" "$ORIGIN"
  echo "Workers local smoke passed: workerd, D1 migrations, assets, claim, session"
  exit 0
fi

: "${WORKERS_STAGING_NAME:?WORKERS_STAGING_NAME is required with --remote}"
: "${WORKERS_STAGING_ORIGIN:?WORKERS_STAGING_ORIGIN is required with --remote}"
if ! [[ "$WORKERS_STAGING_NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "WORKERS_STAGING_NAME must be a lowercase Cloudflare Worker name" >&2
  exit 2
fi
if ! [[ "$WORKERS_STAGING_NAME" =~ (staging|stage|preview|test) ]]; then
  echo "WORKERS_STAGING_NAME must visibly identify a staging/test Worker" >&2
  exit 2
fi
bun -e '
  const value = process.argv[1]
  const url = new URL(value)
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) process.exit(1)
' "$WORKERS_STAGING_ORIGIN" || {
  echo "WORKERS_STAGING_ORIGIN must be an exact HTTPS origin" >&2
  exit 2
}

REMOTE_DB="ome-smoke-$(date +%Y%m%d%H%M%S)-$$"
write_config "$WORKERS_STAGING_NAME" "$WORKERS_STAGING_ORIGIN" 0
"$WRANGLER" --cwd "$SERVER_DIR" d1 create "$REMOTE_DB" --binding DB --use-remote --update-config --config "$CONFIG"
REMOTE_DB_CREATED=1
CONFIG_PATH="$CONFIG" ROOT_PATH="$ROOT" bun -e '
  const config = await Bun.file(process.env.CONFIG_PATH).json()
  config.d1_databases[0].migrations_dir = `${process.env.ROOT_PATH}/apps/server/migrations`
  await Bun.write(process.env.CONFIG_PATH, JSON.stringify(config, null, 2))
'
CI=1 "$WRANGLER" --cwd "$SERVER_DIR" d1 migrations apply DB --remote --config "$CONFIG"
REMOTE_WORKER_CREATED=1
"$WRANGLER" --cwd "$SERVER_DIR" deploy --config "$CONFIG"
smoke_http "$WORKERS_STAGING_ORIGIN" "$WORKERS_STAGING_ORIGIN"
echo "Workers remote staging smoke passed; cleanup will delete the staging Worker and ephemeral D1"
