#!/usr/bin/env bash
# Fetch one URL to a file with bounded exponential backoff — the single path
# every network fetch in CI setup goes through (#2867).
#
# The outage this pins: the `Install pinned tq` step fetched its installer with
# `curl --fail --retry 1` and a transient
# `curl: (22) The requested URL returned error: 403` failed the entire test job.
# The other seven checks were green; nothing about the change was wrong. The
# `--retry` flag was already there and bought nothing, because curl only
# reschedules its own fixed set of transient statuses (408, 429, 5xx) — a 403
# from an API edge is not on that list and is never retried. Passing
# `--retry-all-errors` would fix that one flag in that one step; a shared script
# fixes it everywhere and keeps the next fetch from being special-cased too.
#
# A failure after the whole budget names the URL and the observed HTTP status,
# so the log distinguishes "unreachable" (no status was ever observed) from
# "wrong" (the server answered, and answered 4xx). That distinction is what a
# human reads to tell an infrastructure blip from a real defect.
#
# Usage: ci-fetch-with-retry.sh <url> <output-path> [extra curl args...]
#
# Knobs (env, defaults tuned for CI; tests tighten the pacing):
#   CI_FETCH_ATTEMPTS         total attempts, including the first  (default 5)
#   CI_FETCH_INITIAL_DELAY_S  first backoff, doubled each retry    (default 2)
#   CI_FETCH_MAX_TIME_S       per-attempt curl timeout             (default 120)

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: ci-fetch-with-retry.sh <url> <output-path> [curl args...]" >&2
  exit 2
fi

url="$1"
output="$2"
shift 2

attempts="${CI_FETCH_ATTEMPTS:-5}"
delay="${CI_FETCH_INITIAL_DELAY_S:-2}"
max_time="${CI_FETCH_MAX_TIME_S:-120}"

status="000"
attempt=1

while [ "$attempt" -le "$attempts" ]; do
  set +e
  status="$(
    curl --silent --show-error --location \
      --max-time "$max_time" \
      --output "$output" \
      --write-out '%{http_code}' \
      "$@" \
      "$url"
  )"
  curl_exit=$?
  set -e

  # A hard curl failure can leave the status unwritten; treat it as "no answer".
  case "$status" in
    ''|*[!0-9]*) status="000" ;;
  esac

  if [ "$curl_exit" -eq 0 ] && [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
    exit 0
  fi

  # Never leave a partial or error body where a caller would execute it.
  rm -f "$output"

  echo "fetch attempt ${attempt}/${attempts} failed: status=${status} curl_exit=${curl_exit} url=${url}" >&2

  if [ "$attempt" -lt "$attempts" ]; then
    if [ "$delay" -gt 0 ]; then
      echo "  retrying in ${delay}s" >&2
      sleep "$delay"
    fi
    delay=$((delay * 2))
  fi

  attempt=$((attempt + 1))
done

echo "fetch failed after ${attempts} attempts: ${url}" >&2
if [ "$status" = "000" ]; then
  echo "  the host was unreachable — no HTTP status was ever observed" >&2
else
  echo "  the server answered with HTTP ${status} on the last attempt" >&2
fi
exit 1
