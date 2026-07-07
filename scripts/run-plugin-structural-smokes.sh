#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

mapfile -t smokes < <(find plugins -path '*/scripts/structural-smoke.sh' -type f | sort)

if [[ "${#smokes[@]}" -eq 0 ]]; then
  echo "error: no plugin structural smoke scripts found" >&2
  exit 1
fi

for smoke in "${smokes[@]}"; do
  bash "$smoke"
done

echo "plugin structural smoke fleet ok"
