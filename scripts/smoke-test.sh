#!/usr/bin/env bash
# Starts the instance image against a real Postgres and exercises the API.
# Usage: IMAGE=karatos-brain:ci DB_URL=postgresql://... scripts/smoke-test.sh
#        IMAGE=local runs the built server with node instead of Docker.
set -euo pipefail

KEY=$(openssl rand -hex 32)
NAME=brain-smoke
export INSTANCE_NAME="Smoke Test Jewelers" ORGANIZATION_ID=smoke-test INSTANCE_API_KEY="$KEY" SUPABASE_DB_URL="$DB_URL" PORT=8080

if [ "$IMAGE" = "local" ]; then
  LOG=$(mktemp)
  node packages/server/dist/main.js >"$LOG" 2>&1 &
  PID=$!
  trap 'cat "$LOG"; kill $PID 2>/dev/null || true' EXIT
else
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --network host \
    -e INSTANCE_NAME -e ORGANIZATION_ID -e INSTANCE_API_KEY -e SUPABASE_DB_URL -e PORT "$IMAGE" >/dev/null
  trap 'docker logs "$NAME"; docker rm -f "$NAME" >/dev/null' EXIT
fi

for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:8080/healthz >/dev/null && break
  sleep 1
done

expect() {
  local want=$1 got=$2 what=$3
  if [ "$got" != "$want" ]; then echo "FAIL: $what returned $got, expected $want"; exit 1; fi
  echo "ok: $what -> $got"
}

EVENT='{"id":"evt_smoke_1","source":"manual","type":"order.created","occurredAt":"2026-10-01T12:00:00Z","receivedAt":"2026-10-01T12:00:01Z","idempotencyKey":"smoke-1","payload":{"orderId":"1"}}'
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:8080$1" -H "content-type: application/json" "${@:3}" -d "$2"; }

expect 200 "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz)" "health"
expect 401 "$(post /v1/events "$EVENT")" "event without key"
expect 202 "$(post /v1/events "$EVENT" -H "authorization: Bearer $KEY")" "first event"
expect 200 "$(post /v1/events "$EVENT" -H "authorization: Bearer $KEY")" "replayed event"
OTHER='{"organizationId":"other-jeweler","id":"evt_smoke_2","source":"manual","type":"order.created","occurredAt":"2026-10-01T12:00:00Z","receivedAt":"2026-10-01T12:00:01Z","idempotencyKey":"smoke-2","payload":{}}'
expect 403 "$(post /v1/events "$OTHER" -H "authorization: Bearer $KEY")" "other client's event"
expect 400 "$(post /v1/events '{"type":"Not Valid"}' -H "authorization: Bearer $KEY")" "invalid event"
expect 200 "$(post /v1/reason '{}' -H "authorization: Bearer $KEY")" "reason"
expect 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KEY" http://127.0.0.1:8080/v1/recommendations)" "list recommendations"

ROWS=$(psql "$DB_URL" -tAc "select count(*) from events where organization_id = 'smoke-test'")
expect 1 "$ROWS" "events stored in Postgres"
expect 1 "$(psql "$DB_URL" -tAc "select count(*) from dead_letter_events where organization_id = 'smoke-test'")" "dead letter stored"
expect 1 "$(psql "$DB_URL" -tAc "select count(*) from reasoning_runs where organization_id = 'smoke-test'")" "reasoning run stored"
