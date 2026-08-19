#!/bin/sh
# smoke — drive every command once against a fake daemon and record what happened.
#
# The panes are the half a unit test cannot reach: raw mode, the alternate
# screen, a refresh loop and a socket read all only exist together. This runs
# them for a few seconds each against `scripts/fake-daemon.mjs` and writes one
# transcript, so a change to any of them is checked end to end before install.
set -u

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${1:-/tmp/red-skills-smoke.txt}
sock=/tmp/red-skills-smoke.sock

: > "$out"
say() { printf '\n=== %s ===\n' "$1" >> "$out"; }
strip() { sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b][^\x07]*\x07//g' | tr -d '\r'; }

rm -f "$sock"
node "$root/scripts/fake-daemon.mjs" "$sock" 2>/dev/null &
daemon=$!
trap 'kill "$daemon" 2>/dev/null; rm -f "$sock"' EXIT
sleep 1

export REDSKILLED_SOCKET="$sock"
export NO_COLOR=1
export HERDR_PLUGIN_STATE_DIR=/tmp/red-skills-smoke-state
export HERDR_PLUGIN_CONFIG_DIR=/tmp/red-skills-smoke-config
rm -rf "$HERDR_PLUGIN_STATE_DIR" "$HERDR_PLUGIN_CONFIG_DIR"

say "version"
node "$root/bin/red-skills-herdr.mjs" --version >> "$out" 2>&1

say "help"
node "$root/bin/red-skills-herdr.mjs" --help >> "$out" 2>&1

say "doctor"
node "$root/bin/red-skills-herdr.mjs" doctor >> "$out" 2>&1
printf 'exit=%s\n' "$?" >> "$out"

say "status"
node "$root/bin/red-skills-herdr.mjs" status >> "$out" 2>&1
printf 'exit=%s\n' "$?" >> "$out"

say "status --json (keys only)"
node "$root/bin/red-skills-herdr.mjs" status --json 2>&1 | head -c 400 >> "$out"

say "watch --once (first read: reachable, so nothing to announce)"
node "$root/bin/red-skills-herdr.mjs" watch --once >> "$out" 2>&1

say "dashboard (3s in a pipe, escapes stripped)"
COLUMNS=110 LINES=32 timeout 3 node "$root/bin/red-skills-herdr.mjs" dashboard 2>&1 | strip | grep -v '^$' >> "$out"

say "logs (3s)"
COLUMNS=110 LINES=20 timeout 3 node "$root/bin/red-skills-herdr.mjs" logs 2>&1 | strip | grep -v '^$' >> "$out"

say "events (3s)"
COLUMNS=110 LINES=20 timeout 3 node "$root/bin/red-skills-herdr.mjs" logs --events 2>&1 | strip | grep -v '^$' >> "$out"

say "unknown command"
node "$root/bin/red-skills-herdr.mjs" nope >> "$out" 2>&1
printf 'exit=%s\n' "$?" >> "$out"

printf '\nsmoke transcript: %s\n' "$out"
