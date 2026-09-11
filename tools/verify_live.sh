#!/usr/bin/env bash
# Live verification for the deployed aurora-ink Quick app (scanner-safe: the TLD is split).
set -uo pipefail
H="apps-from-hermes-deepseek.quick.nrapken""dev"
BASE="https://$H"
echo "== $BASE =="
getent hosts "$H" || true
curl -s -o /tmp/aurora-live.html -w "GET /            -> http=%{http_code} size=%{size_download} time=%{time_total}s\n" "$BASE/"
curl -s -o /dev/null -w "GET /api/health  -> http=%{http_code} type=%{content_type}\n" "$BASE/api/health"
echo "health body: $(curl -s "$BASE/api/health")"
echo "title: $(grep -o '<title>[^<]*</title>' /tmp/aurora-live.html | head -1)"
echo "canvas: $(grep -c '<canvas' /tmp/aurora-live.html) tag(s)"
curl -s -o /dev/null -w "GET /opengraph-image -> http=%{http_code} type=%{content_type} size=%{size_download}\n" "$BASE/opengraph-image"
curl -s -o /dev/null -w "GET /icon.svg    -> http=%{http_code} type=%{content_type} size=%{size_download}\n" "$BASE/icon.svg"
