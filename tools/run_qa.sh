#!/usr/bin/env bash
# Playwright QA against a local production server (falls back to building first).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3123}"
if [ ! -f .next/BUILD_ID ]; then
  echo "== building =="
  npm run build
fi
echo "== starting next on :$PORT =="
# A stale `next start` from an earlier run can hold the port and serve an old (broken) build,
# which shows up as a frozen page and 500s. Free the port first.
if ss -ltnp 2>/dev/null | grep -q ":$PORT "; then
  echo "   port :$PORT is busy — stopping the stale server"
  for pid in $(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
fi
npx next start -p "$PORT" >/tmp/aurora-ink-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "server did not come up"; cat /tmp/aurora-ink-server.log; exit 1; }
echo "== playwright =="
node tools/qa_webgpu.cjs "http://127.0.0.1:$PORT" tools/out/qa
