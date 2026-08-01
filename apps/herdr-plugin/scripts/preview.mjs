#!/usr/bin/env node
/**
 * preview — draw one frame from the fixtures, without a daemon.
 *
 * A pane is the one surface you cannot code-review by reading it: alignment,
 * colour and truncation are only true at a width. This prints the same frames
 * the pane draws, at a width you choose, so a layout change can be seen before
 * it is installed.
 *
 *   node scripts/preview.mjs                 # the overview at 120x40
 *   node scripts/preview.mjs --columns 80    # the width that actually breaks it
 *   node scripts/preview.mjs --view down     # the unreachable frame
 *   node scripts/preview.mjs --view events   # the host event lane
 */
import { renderDashboard } from "../src/ui/dashboard.mjs";
import { renderEventRow, renderLogView } from "../src/ui/logs.mjs";
import { parseArgs } from "../bin/red-skills-herdr.mjs";
import { snapshot } from "../tests/fixtures.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const size = { columns: Number(flags.columns ?? 120), rows: Number(flags.rows ?? 40) };
const view = flags.view ?? "overview";
const state = { view: view === "help" ? "help" : "overview", mode: "global", verbose: flags.verbose !== false, selected: 0, message: null };

let lines;
if (view === "down") {
  lines = renderDashboard({
    snapshot: { reachable: false, payload: null, hostState: null, error: { message: "redskilled is not reachable at /run/user/1000/red-skills/ab12/redskilled.sock: ENOENT" } },
    state,
    size,
    socket: { socketPath: "/run/user/1000/red-skills/ab12/redskilled.sock", source: "derived from XDG_RUNTIME_DIR" },
  });
} else if (view === "events") {
  const records = [
    { ts: "2026-07-31T11:42:00.000Z", event: "worker-birth", worker_id: "w-2f91a", project_label: "reddb-io/red-skills", pid: 51201, unit: "redskilled-w-2f91a.service" },
    { ts: "2026-07-31T11:51:12.000Z", event: "worker-death", worker_id: "w-11c02", project_label: "reddb-io/red-dev", exit_code: 0 },
    { ts: "2026-07-31T11:57:40.000Z", event: "worker-budget-kill", worker_id: "w-90aa1", project_label: "reddb-io/red-skills", detail: "tree RSS 2.1G over the declared MemoryMax of 2G" },
    { ts: "2026-07-31T11:58:02.000Z", event: "worker-death", worker_id: "w-90aa1", project_label: "reddb-io/red-skills", signal: "SIGKILL" },
  ];
  lines = renderLogView({
    title: "host event lane",
    subtitle: "/run/user/1000/red-skills/ab12/redskilled.events.toonl — birth, death, budget-kill",
    lines: records,
    offset: 0,
    follow: true,
    size,
    empty: "no lane yet",
    render: (record, ctx) => renderEventRow(record, ctx),
  });
} else if (view === "logs") {
  lines = renderLogView({
    title: "worker log",
    subtitle: "w-2f91a · reddb-io/red-skills · up 18m00s · /home/op/red-skills/.red/tmp/logs/2026-07-31/w-2f91a.log · 412K",
    lines: [
      "claim: #2931 gate-hardening: the ratchet only ever shrinks",
      "worktree: .red/tmp/workers/w-2f91a/2931/worktree",
      "gate: pnpm -C apps/dev test:invariants",
      "WARN  toon-json-guard: 1 new JSON file I/O site, see .red/contracts/",
      "gate: vitest packages/red-castle — 412 passed",
      "ERROR push refused: non-fast-forward on origin/main",
      "landing: rebased onto origin/main, retrying",
      "ok: PR #2952 opened",
    ],
    offset: 0,
    follow: true,
    size,
    empty: "nothing yet",
  });
} else {
  lines = renderDashboard({ snapshot: snapshot(), state, size, localProject: "reddb-io/red-skills", now: "2026-07-31T12:00:00.000Z" });
}

process.stdout.write(`${lines.join("\n")}\n`);
