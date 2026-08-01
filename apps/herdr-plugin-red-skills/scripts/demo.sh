#!/bin/sh
# demo — put a machine with no redskilled into a state where the panes have
# something to show, and take it back out again.
#
# It starts `scripts/fake-daemon.mjs` on a socket of its own and points the
# plugin's config at it. Nothing it shows is true, and the config file says so
# in a `_comment` — a demo you cannot tell from production is how a screenshot
# ends up in an incident report.
#
#   sh scripts/demo.sh start     # fake daemon + config pointing at it
#   sh scripts/demo.sh status    # is it up, and what is the config saying
#   sh scripts/demo.sh stop      # kill it and put the config back
set -u

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
plugin_id=reddb-io.red-skills
runtime=${RED_SKILLS_DEMO_DIR:-/tmp/redskilled-demo}
sock="$runtime/redskilled.sock"
pidfile="$runtime/demo.pid"

config_dir=$(herdr plugin config-dir "$plugin_id" 2>/dev/null) || config_dir=""
[ -n "$config_dir" ] || config_dir="$HOME/.config/herdr/plugins/config/$plugin_id"
config="$config_dir/config.toon"
backup="$config_dir/config.toon.before-demo"

running() {
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

case "${1:-start}" in
start)
  if running; then
    echo "demo already running (pid $(cat "$pidfile"))"
    exit 0
  fi
  mkdir -p "$runtime" "$config_dir"
  # `nohup` because the point is to outlive this shell: a demo that died with
  # the terminal that started it would leave a socket file behind and the next
  # read would be ECONNREFUSED, which reads as a broken plugin rather than a
  # daemon nobody is running.
  rm -f "$sock"
  nohup node "$root/scripts/fake-daemon.mjs" --socket "$sock" >"$runtime/daemon.log" 2>&1 &
  echo $! > "$pidfile"
  sleep 1
  if ! running; then
    echo "the fake daemon did not start; see $runtime/daemon.log" >&2
    exit 1
  fi

  # An existing config is moved aside rather than overwritten: `stop` has to be
  # able to give back exactly what was there, or the demo is a one-way door.
  if [ -f "$config" ] && [ ! -f "$backup" ]; then
    mv "$config" "$backup"
    echo "kept your config at $backup"
  fi
  cat > "$config" <<TOON
_comment: WRITTEN BY scripts/demo.sh — socketPath points at a FAKE daemon. Nothing this shows is true. Undo with: sh scripts/demo.sh stop
refreshMs: 1500
mode: global
verbose: true
socketPath: $sock
notifications:
  enabled: true
  pollMs: 5000
  renotifyMs: 60000
  workerBirth: true
  budgetPressureAt: 0.8
TOON

  echo "demo up (pid $(cat "$pidfile"))"
  echo "  socket      $sock"
  echo "  event lane  $runtime/redskilled.events.toonl"
  echo "  worker logs $runtime/logs/"
  echo "  config      $config"
  echo
  echo "check it:  node $root/bin/red-skills-herdr.mjs doctor"
  echo "watch it:  node $root/bin/red-skills-herdr.mjs dashboard"
  ;;

status)
  if running; then
    echo "fake daemon: running (pid $(cat "$pidfile")) on $sock"
  else
    echo "fake daemon: not running"
  fi
  if [ -f "$config" ] && grep -q "WRITTEN BY scripts/demo.sh" "$config" 2>/dev/null; then
    echo "config:      demo config in place at $config"
  elif [ -f "$config" ]; then
    echo "config:      your own config at $config (untouched by the demo)"
  else
    echo "config:      none — the plugin runs on its declared defaults"
  fi
  [ -f "$backup" ] && echo "backup:      $backup"
  exit 0
  ;;

stop)
  if running; then
    kill "$(cat "$pidfile")" 2>/dev/null
    echo "stopped the fake daemon"
  else
    echo "no fake daemon was running"
  fi
  rm -f "$pidfile" "$sock"

  if [ -f "$config" ] && grep -q "WRITTEN BY scripts/demo.sh" "$config" 2>/dev/null; then
    rm -f "$config"
    if [ -f "$backup" ]; then
      mv "$backup" "$config"
      echo "put your own config back"
    else
      echo "removed the demo config; the plugin is back on its declared defaults"
    fi
  fi
  echo "the event lane and worker logs are left at $runtime — remove it when you are done"
  ;;

*)
  echo "usage: sh scripts/demo.sh [start|status|stop]" >&2
  exit 2
  ;;
esac
