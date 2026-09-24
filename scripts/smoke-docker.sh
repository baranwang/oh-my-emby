#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${OH_MY_EMBY_IMAGE:-oh-my-emby:verify}"
SUFFIX="$(date +%s)-$$"
NETWORK="oh-my-emby-smoke-${SUFFIX}"
CONTAINER="oh-my-emby-smoke-${SUFFIX}"
VOLUME="oh-my-emby-smoke-${SUFFIX}"
TEMP_DIR="$(mktemp -d)"
CREATED_NETWORK=0
CREATED_VOLUME=0
CREATED_CONTAINER=0

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "$CREATED_CONTAINER" == 1 ]]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if [[ "$CREATED_NETWORK" == 1 ]]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
  if [[ "$CREATED_VOLUME" == 1 ]]; then docker volume rm "$VOLUME" >/dev/null 2>&1 || true; fi
  rm -rf "$TEMP_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

docker image inspect "$IMAGE" >/dev/null
docker network create "$NETWORK" >/dev/null
CREATED_NETWORK=1
docker volume create "$VOLUME" >/dev/null
CREATED_VOLUME=1
docker run -d --name "$CONTAINER" --network "$NETWORK" -p 127.0.0.1::3000 -v "$VOLUME:/data" "$IMAGE" >/dev/null
CREATED_CONTAINER=1

PORT="$(docker port "$CONTAINER" 3000/tcp | sed -n 's/.*://p' | tail -n 1)"
BASE_URL="http://127.0.0.1:$PORT"
for _ in {1..60}; do
  if curl --fail --silent --show-error "$BASE_URL/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl --fail --silent --show-error "$BASE_URL/health" >"$TEMP_DIR/health.json"; then
  docker logs "$CONTAINER"
  exit 1
fi
grep -q '"status":"ok"' "$TEMP_DIR/health.json"

PUBLIC_HOST=(-H "Host: smoke.example.com")

status="$(curl --silent --show-error -D "$TEMP_DIR/headers" -o "$TEMP_DIR/body" -w '%{http_code}' "${PUBLIC_HOST[@]}" -H "Accept: text/html" "$BASE_URL/dashboard/servers")"
[[ "$status" == 200 ]]
grep -qi '^content-type:.*text/html' "$TEMP_DIR/headers"

for path in /api/dashboard/not-a-route /dashboard/assets/missing.js; do
  status="$(curl --silent --show-error -D "$TEMP_DIR/headers" -o "$TEMP_DIR/body" -w '%{http_code}' "${PUBLIC_HOST[@]}" -H "Accept: text/html" "$BASE_URL$path")"
  [[ "$status" == 404 ]]
  if grep -qi '^content-type:.*text/html' "$TEMP_DIR/headers"; then exit 1; fi
done

status="$(curl --silent --show-error -D "$TEMP_DIR/headers" -o "$TEMP_DIR/body" -w '%{http_code}' "${PUBLIC_HOST[@]}" -H "Origin: https://smoke.example.com" -H "Content-Type: application/json" --data '{"username":"owner","password":"valid password"}' "$BASE_URL/api/dashboard/claim")"
[[ "$status" == 200 ]]
grep -q '"authenticated":true' "$TEMP_DIR/body"
grep -qi '^set-cookie:.*Secure' "$TEMP_DIR/headers"
SESSION_COOKIE="$(tr -d '\r' <"$TEMP_DIR/headers" | sed -n 's/^[Ss]et-[Cc]ookie:[[:space:]]*\([^;]*\).*/\1/p' | head -n 1)"
[[ -n "$SESSION_COOKIE" ]]

status="$(curl --silent --show-error -o "$TEMP_DIR/body" -w '%{http_code}' -H "Cookie: $SESSION_COOKIE" "${PUBLIC_HOST[@]}" "$BASE_URL/api/dashboard/session")"
[[ "$status" == 200 ]]
grep -q '"authenticated":true' "$TEMP_DIR/body"

echo "Docker smoke passed: health, Dashboard deep link, non-HTML misses, claim, session"
