#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
DEFAULT_WRANGLER="$SERVER_DIR/node_modules/.bin/wrangler"
WRANGLER="${WORKERS_SMOKE_WRANGLER:-$DEFAULT_WRANGLER}"
DEFAULT_API_BASE_URL="https://api.cloudflare.com/client/v4"
API_BASE_URL="${WORKERS_SMOKE_API_BASE_URL:-${CLOUDFLARE_API_BASE_URL:-$DEFAULT_API_BASE_URL}}"
API_BASE_IS_LOOPBACK=0
TEMP_DIR=
CONFIG=
STATE_DIR=
LOG=
MODE=local
DEV_PID=
RUN_ID=
BENCHMARK_TOKEN=
OWNERSHIP_TOKEN=
REMOTE_WORKER=
REMOTE_DB=
REMOTE_DB_ID=
REMOTE_WORKER_DEPLOY_ATTEMPTED=0
REMOTE_WORKER_CLEANUP_ELIGIBLE=0
REMOTE_DB_CREATE_SUCCEEDED=0

if [[ "${1:-}" == "--remote" ]]; then
  MODE=remote
elif [[ "${1:-}" == "--plan-remote" ]]; then
  MODE=remote-plan
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--remote|--plan-remote]" >&2
  exit 2
fi

owned_targets() {
  [[ "$RUN_ID" =~ ^[a-f0-9]{32}$ ]] &&
    [[ "$REMOTE_WORKER" == "ome-worker-$RUN_ID" ]] &&
    [[ "$REMOTE_DB" == "ome-d1-$RUN_ID" ]]
}

if [[ "$MODE" != local ]]; then
  RUN_ID="$(bun -e 'process.stdout.write(crypto.randomUUID().replaceAll("-", ""))')"
  BENCHMARK_TOKEN="$(bun -e 'process.stdout.write(crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""))')"
  OWNERSHIP_TOKEN="$(bun -e 'process.stdout.write(crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""))')"
  REMOTE_WORKER="ome-worker-$RUN_ID"
  REMOTE_DB="ome-d1-$RUN_ID"
  owned_targets || {
    echo "refusing remote smoke with an invalid ownership marker" >&2
    exit 2
  }
fi

if [[ "$MODE" == remote-plan ]]; then
  RUN_ID="$RUN_ID" REMOTE_WORKER="$REMOTE_WORKER" REMOTE_DB="$REMOTE_DB" bun -e '
    console.log(JSON.stringify({
      mode: "remote-plan",
      runId: process.env.RUN_ID,
      worker: process.env.REMOTE_WORKER,
      database: process.env.REMOTE_DB,
      smokeOrigin: {
        source: "wrangler-deploy-output",
        expectedWorker: process.env.REMOTE_WORKER
      },
      benchmark: {
        entrypoint: "scripts/workers-pbkdf2-benchmark.ts",
        runner: "scripts/benchmark-workers-pbkdf2.ts",
        method: "POST",
        targetWorker: process.env.REMOTE_WORKER,
        authorization: "ephemeral-run-token",
        measurement: "remote-request-upper-bound"
      },
      cleanup: {
        worker: process.env.REMOTE_WORKER,
        database: process.env.REMOTE_DB
      }
    }))
  '
  exit 0
fi

if [[ "$MODE" == remote ]]; then
  if [[ ! "${CLOUDFLARE_ACCOUNT_ID:-}" =~ ^[a-fA-F0-9]{32}$ || -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "remote smoke requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN" >&2
    exit 2
  fi
  API_BASE_URL="$(API_BASE_URL="$API_BASE_URL" DEFAULT_API_BASE_URL="$DEFAULT_API_BASE_URL" bun -e '
    const input = process.env.API_BASE_URL
    const standard = process.env.DEFAULT_API_BASE_URL
    let url
    try { url = new URL(input) } catch { process.exit(1) }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    if (url.username || url.password || url.search || url.hash || url.pathname.endsWith("/") ||
      (input !== standard && (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")))) {
      process.exit(1)
    }
    process.stdout.write(url.toString())
  ')" || {
    echo "remote smoke API override must be an exact loopback URL" >&2
    exit 2
  }
  [[ "$API_BASE_URL" == "$DEFAULT_API_BASE_URL" ]] || API_BASE_IS_LOOPBACK=1
  if [[ -n "${WORKERS_SMOKE_WRANGLER:-}" && "$API_BASE_IS_LOOPBACK" != 1 ]]; then
    echo "remote smoke Wrangler override requires a loopback API override" >&2
    exit 2
  fi
  if [[ ! -x "$WRANGLER" ]]; then
    echo "remote smoke Wrangler executable is unavailable" >&2
    exit 2
  fi
  export CLOUDFLARE_API_BASE_URL="$API_BASE_URL"
fi

TEMP_DIR="$(mktemp -d)"
CONFIG="$TEMP_DIR/wrangler.json"
STATE_DIR="$TEMP_DIR/state"
LOG="$TEMP_DIR/wrangler.log"

cleanup() {
  local code=$?
  local cleanup_failed=0
  local status
  trap - EXIT INT TERM
  if [[ "$code" != 0 && -s "$LOG" ]]; then cat "$LOG" >&2; fi
  if [[ -n "$DEV_PID" ]]; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$REMOTE_WORKER_DEPLOY_ATTEMPTED" == 1 || "$REMOTE_DB_CREATE_SUCCEEDED" == 1 ]]; then
    if ! owned_targets; then
      echo "refusing cleanup for targets not owned by this run" >&2
      cleanup_failed=1
    else
      if [[ "$REMOTE_WORKER_CLEANUP_ELIGIBLE" == 1 ]]; then
        status="$(curl --silent --show-error --output "$TEMP_DIR/delete-worker.json" --write-out '%{http_code}' \
          --request DELETE --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
          "$API_BASE_URL/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$REMOTE_WORKER")" || status=000
        if [[ "$status" != 200 ]] || ! API_BODY="$TEMP_DIR/delete-worker.json" bun -e '
          const body = await Bun.file(process.env.API_BODY).json().catch(() => null)
          if (body?.success !== true) process.exit(1)
        '; then
          cleanup_failed=1
        fi
      elif [[ "$REMOTE_WORKER_DEPLOY_ATTEMPTED" == 1 ]]; then
        echo "Manual cleanup may be required for Worker $REMOTE_WORKER; ownership was not verified, so it was not deleted." >&2
      fi
      if [[ "$REMOTE_DB_CREATE_SUCCEEDED" == 1 && "$REMOTE_DB_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
        status="$(curl --silent --show-error --output "$TEMP_DIR/delete-d1.json" --write-out '%{http_code}' \
          --request DELETE --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
          "$API_BASE_URL/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$REMOTE_DB_ID")" || status=000
        if [[ "$status" != 200 ]] || ! API_BODY="$TEMP_DIR/delete-d1.json" bun -e '
          const body = await Bun.file(process.env.API_BODY).json().catch(() => null)
          if (body?.success !== true) process.exit(1)
        '; then
          cleanup_failed=1
        fi
      elif [[ "$REMOTE_DB_CREATE_SUCCEEDED" == 1 ]]; then
        echo "Manual cleanup may be required for D1 database $REMOTE_DB; its creation ID was unavailable, so it was not deleted." >&2
      fi
    fi
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

write_config "$REMOTE_WORKER" "https://invalid.example" 0
PREFLIGHT_STATUS="$(curl --silent --show-error --output "$TEMP_DIR/worker-preflight.json" --write-out '%{http_code}' \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$API_BASE_URL/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$REMOTE_WORKER")" || {
  echo "Worker ownership preflight failed before deployment" >&2
  exit 1
}
if [[ "$PREFLIGHT_STATUS" == 200 ]]; then
  echo "Worker ownership preflight found an existing script; refusing to deploy or delete $REMOTE_WORKER" >&2
  exit 1
fi
if [[ "$PREFLIGHT_STATUS" != 404 ]] || ! API_BODY="$TEMP_DIR/worker-preflight.json" bun -e '
  const body = await Bun.file(process.env.API_BODY).json().catch(() => null)
  if (body?.success !== false || !Array.isArray(body.errors) ||
    !body.errors.some((error) => error?.code === 10007)) process.exit(1)
'; then
  echo "Worker ownership preflight was ambiguous; refusing to deploy or delete $REMOTE_WORKER" >&2
  exit 1
fi

"$WRANGLER" --cwd "$SERVER_DIR" d1 create "$REMOTE_DB" --binding DB --use-remote --update-config --config "$CONFIG"
REMOTE_DB_CREATE_SUCCEEDED=1
REMOTE_DB_ID="$(CONFIG_PATH="$CONFIG" EXPECTED_DB="$REMOTE_DB" bun -e '
  const config = await Bun.file(process.env.CONFIG_PATH).json()
  const bindings = config.d1_databases
  if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.binding !== "DB" ||
    bindings[0]?.database_name !== process.env.EXPECTED_DB ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(bindings[0]?.database_id ?? "")) {
    process.exit(1)
  }
  process.stdout.write(bindings[0].database_id)
')" || {
  echo "D1 creation did not return exactly one valid database ID" >&2
  exit 1
}
CONFIG_PATH="$CONFIG" ROOT_PATH="$ROOT" bun -e '
  const config = await Bun.file(process.env.CONFIG_PATH).json()
  config.d1_databases[0].migrations_dir = `${process.env.ROOT_PATH}/apps/server/migrations`
  await Bun.write(process.env.CONFIG_PATH, JSON.stringify(config, null, 2))
'
CI=1 "$WRANGLER" --cwd "$SERVER_DIR" d1 migrations apply DB --remote --config "$CONFIG"

CONFIG_PATH="$CONFIG" ROOT_PATH="$ROOT" RUN_ID="$RUN_ID" bun -e '
  const config = await Bun.file(process.env.CONFIG_PATH).json()
  config.main = `${process.env.ROOT_PATH}/scripts/workers-smoke-ownership.ts`
  config.vars = { SMOKE_RUN_ID: process.env.RUN_ID }
  delete config.assets
  delete config.triggers
  await Bun.write(process.env.CONFIG_PATH, JSON.stringify(config, null, 2))
'
OWNERSHIP_TOKEN="$OWNERSHIP_TOKEN" OWNERSHIP_SECRETS="$TEMP_DIR/ownership-secrets.json" bun -e '
  await Bun.write(process.env.OWNERSHIP_SECRETS, JSON.stringify({
    SMOKE_OWNERSHIP_TOKEN: process.env.OWNERSHIP_TOKEN
  }))
'
REMOTE_WORKER_DEPLOY_ATTEMPTED=1
if ! "$WRANGLER" --cwd "$SERVER_DIR" deploy --strict --config "$CONFIG" \
  --secrets-file "$TEMP_DIR/ownership-secrets.json" 2>&1 | tee "$TEMP_DIR/deploy.log"; then
  echo "Worker ownership probe deployment failed" >&2
  exit 1
fi
ORIGIN="$(ALLOW_LOOPBACK_ORIGIN="$API_BASE_IS_LOOPBACK" DEPLOY_LOG="$TEMP_DIR/deploy.log" EXPECTED_WORKER="$REMOTE_WORKER" bun -e '
  const output = await Bun.file(process.env.DEPLOY_LOG).text()
  const allowLoopback = process.env.ALLOW_LOOPBACK_ORIGIN === "1"
  const candidates = [...new Set(output.match(/https?:\/\/[^\s]+/g) ?? [])]
    .map((value) => { try { return new URL(value) } catch { return null } })
    .filter((url) => url !== null)
    .filter((url) => url.pathname === "/" && !url.search && !url.hash)
    .filter((url) => {
      const worker = url.protocol === "https:" && url.hostname.startsWith(`${process.env.EXPECTED_WORKER}.`) &&
        /^[a-z0-9-]+\.workers\.dev$/.test(url.hostname.slice(process.env.EXPECTED_WORKER.length + 1))
      const loopback = allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"
      return worker || loopback
    })
  if (candidates.length !== 1) process.exit(1)
  const url = candidates[0]
  process.stdout.write(url.origin)
')" || {
  echo "Wrangler did not report exactly one run-owned deployment URL for $REMOTE_WORKER" >&2
  exit 1
}
OWNERSHIP_STATUS="$(curl --silent --show-error --output "$TEMP_DIR/ownership.json" \
  --dump-header "$TEMP_DIR/ownership.headers" --write-out '%{http_code}' --max-time 30 \
  --header "Authorization: Bearer $OWNERSHIP_TOKEN" "$ORIGIN/__ome-smoke-ownership")" || {
  echo "Worker ownership verification request failed for $REMOTE_WORKER" >&2
  exit 1
}
if ! OWNERSHIP_STATUS="$OWNERSHIP_STATUS" OWNERSHIP_BODY="$TEMP_DIR/ownership.json" \
  OWNERSHIP_HEADERS="$TEMP_DIR/ownership.headers" EXPECTED_RUN_ID="$RUN_ID" bun -e '
    const status = process.env.OWNERSHIP_STATUS
    const body = await Bun.file(process.env.OWNERSHIP_BODY).json().catch(() => null)
    const headers = await Bun.file(process.env.OWNERSHIP_HEADERS).text()
    if (status !== "200" || body === null || Object.keys(body).length !== 1 ||
      body.runId !== process.env.EXPECTED_RUN_ID ||
      !/^cache-control:\s*private, no-store\s*$/im.test(headers)) process.exit(1)
  '; then
  echo "Worker ownership verification failed for $REMOTE_WORKER" >&2
  exit 1
fi
REMOTE_WORKER_CLEANUP_ELIGIBLE=1

CONFIG_PATH="$CONFIG" REMOTE_ORIGIN="$ORIGIN" ROOT_PATH="$ROOT" bun -e '
  const config = await Bun.file(process.env.CONFIG_PATH).json()
  config.main = `${process.env.ROOT_PATH}/apps/server/src/platform/workers/index.ts`
  config.vars = { PUBLIC_ORIGIN: process.env.REMOTE_ORIGIN, TRUSTED_PROXIES: "" }
  config.assets = {
    directory: `${process.env.ROOT_PATH}/apps/dashboard/dist`,
    binding: "ASSETS",
    html_handling: "none",
    not_found_handling: "none",
    run_worker_first: true
  }
  config.triggers = { crons: ["*/5 * * * *"] }
  await Bun.write(process.env.CONFIG_PATH, JSON.stringify(config, null, 2))
'
"$WRANGLER" --cwd "$SERVER_DIR" deploy --strict --config "$CONFIG" >/dev/null
smoke_http "$ORIGIN" "$ORIGIN"
CONFIG_PATH="$CONFIG" ROOT_PATH="$ROOT" bun -e '
  const config = await Bun.file(process.env.CONFIG_PATH).json()
  config.main = `${process.env.ROOT_PATH}/scripts/workers-pbkdf2-benchmark.ts`
  config.vars = { BENCHMARK_COMPATIBILITY_DATE: config.compatibility_date }
  delete config.assets
  delete config.triggers
  delete config.d1_databases
  await Bun.write(process.env.CONFIG_PATH, JSON.stringify(config, null, 2))
'
BENCHMARK_TOKEN="$BENCHMARK_TOKEN" BENCHMARK_SECRETS="$TEMP_DIR/benchmark-secrets.json" bun -e '
  await Bun.write(process.env.BENCHMARK_SECRETS, JSON.stringify({
    BENCHMARK_TOKEN: process.env.BENCHMARK_TOKEN
  }))
'
"$WRANGLER" --cwd "$SERVER_DIR" deploy --strict --config "$CONFIG" \
  --secrets-file "$TEMP_DIR/benchmark-secrets.json" >/dev/null
WORKERS_BENCHMARK_ORIGIN="$ORIGIN" WORKERS_BENCHMARK_TOKEN="$BENCHMARK_TOKEN" \
  bun "$ROOT/scripts/benchmark-workers-pbkdf2.ts"
echo "Workers remote staging smoke passed; cleanup will delete only verified Worker $REMOTE_WORKER and D1 ID $REMOTE_DB_ID"
