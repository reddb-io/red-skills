// What a statusline consumer receives is bounded by its own taste, never by the
// size of the machine (#2928).
//
// The document that surfaced this was 571 KB across 19,066 lines, fetched every
// sixty seconds to fill one row of a terminal. The bound here is stated as a
// function of the OPTIONS alone — the width and the Worker budget the operator
// declared — so a host holding five hundred Workers hands back the same-sized
// answer a host holding one does, and the test proves it by asking both.
//
// The second half is the other way a line stops being useful: not too big, but
// absent. A blank statusline reads as "no Workers", so a host that did not answer
// renders a sentence saying so and the command still exits 0.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { runStatusline } from "../src/cli.js";
import { readRedskilledStatuslineString } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { buildStatuslinePayload, type RedskilledStatuslinePayload } from "../src/statusline-payload.js";
import {
  REDSKILLED_RENDER_ABSENCE,
  REDSKILLED_STATUSLINE_DEFAULTS,
  redskilledStatuslineBound,
  redskilledStatuslineCharacters,
  renderRedskilledStatusline,
  renderRedskilledStatuslineAbsence,
  type RedskilledStatuslineOptions,
} from "@reddb-io/redskilled-render";
import type { RedskilledWorkerLogLine } from "../src/worker-log.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const MB = 1024 * 1024;

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-statusline-bound-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function options(overrides: Partial<RedskilledStatuslineOptions> = {}): RedskilledStatuslineOptions {
  return { ...REDSKILLED_STATUSLINE_DEFAULTS, ...overrides };
}

/** A host of any size, every Worker holding a long name and a long logged line. */
function crowdedPayload(workerCount: number): RedskilledStatuslinePayload {
  const workers: RedskilledWorkerView[] = Array.from({ length: workerCount }, (_, index) => ({
    worker_id: `worker-with-a-deliberately-long-identifier-${index}`,
    project_label: `acme/a-project-whose-label-is-not-short-${index % 40}`,
    pid: 5_000 + index,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: `/tmp/acme/${index}`,
    isolated: true,
    unit: `red-worker-${index}.service`,
    budget: { memory_max: "1G" },
    warnings: [],
  }));
  const logLines: Record<string, RedskilledWorkerLogLine> = {};
  const rss: Record<string, number> = {};
  for (const [index, worker] of workers.entries()) {
    rss[worker.worker_id] = (index + 1) * MB;
    logLines[worker.worker_id] = {
      line: "x".repeat(400),
      published_at: "2026-07-29T01:00:00.000Z",
      source: "heartbeat",
    };
  }
  return buildStatuslinePayload({
    hostState: buildHostState({
      daemonVersion: "0.1.0",
      machineIdHash: "mach",
      sessionKeyHash: "sess",
      pid: 99,
      startedAt: "2026-07-29T00:00:00.000Z",
      workers,
    }),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss,
    logLines,
    sampledAt: "2026-07-29T01:00:00.000Z",
    now: "2026-07-29T01:00:05.000Z",
  });
}

describe("the size of a statusline answer", () => {
  it("is fixed by the declared taste, whatever the host is holding", () => {
    for (const taste of [
      options({ mode: "global" }),
      options({ mode: "global", verbose: true }),
      options({ mode: "global", verbose: true, maxWorkers: 12, maxWidth: 200 }),
      options({ mode: "local", project: "acme/a-project-whose-label-is-not-short-0", verbose: true }),
    ]) {
      const bound = redskilledStatuslineBound(taste);
      for (const workerCount of [0, 1, 4, 40, 500]) {
        const render = renderRedskilledStatusline(crowdedPayload(workerCount), taste);
        expect(render.lines.length).toBeLessThanOrEqual(bound.max_lines);
        for (const line of render.lines) expect([...line].length).toBeLessThanOrEqual(bound.max_line_width);
        expect(redskilledStatuslineCharacters(render)).toBeLessThanOrEqual(bound.max_characters);
      }
    }
  });

  it("holds on the wire too: the answer a consumer reads back stays small", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: {}, cpu_seconds: {} }),
    });
    running.push(daemon);
    for (let index = 0; index < 300; index += 1) {
      daemon.trackWorker({
        worker_id: `worker-with-a-deliberately-long-identifier-${index}`,
        project_label: `acme/a-project-whose-label-is-not-short-${index % 40}`,
        pid: 5_000 + index,
        started_at: "2026-07-29T00:00:00.000Z",
        workspace_path: `/tmp/acme/${index}`,
        isolated: true,
        warnings: [],
      });
    }

    const taste = options({ mode: "global", verbose: true });
    const render = await readRedskilledStatuslineString(paths, taste);
    const bound = redskilledStatuslineBound(taste);

    expect(redskilledStatuslineCharacters(render)).toBeLessThanOrEqual(bound.max_characters);
    // The WHOLE response, envelope included — the number that actually crosses
    // the socket sixty times an hour. A statusline is one row; four kilobytes is
    // already generous, and the document this replaced was a hundred times that.
    expect(JSON.stringify(render).length).toBeLessThan(4_096);
  });
});

describe("a host that did not answer", () => {
  it("renders a stated absence rather than a blank line", () => {
    const render = renderRedskilledStatuslineAbsence({
      options: options(),
      generated_at: "2026-07-29T01:00:05.000Z",
    });

    expect(render.line).toBe(REDSKILLED_RENDER_ABSENCE);
    expect(render.lines).toEqual([REDSKILLED_RENDER_ABSENCE]);
    expect(render.line.trim()).not.toBe("");
    // Neither a fresh answer nor a project verdict: nobody was there to give one.
    expect(render.stale).toBe(true);
    expect(render.project_match).toBe("unanswered");
  });

  it("is what the command prints, on stdout, still exiting 0", async () => {
    const paths = await sessionPaths();
    const cwd = await scratch("redskilled-statusline-absent-project-");
    await mkdir(join(cwd, ".red"), { recursive: true });
    await writeFile(join(cwd, ".red", "config.yaml"), "project:\n  name: acme/widgets\n", "utf8");

    const written: string[] = [];
    const warned: string[] = [];
    const code = await runStatusline([], {
      cwd,
      paths,
      write: (line) => written.push(line),
      warn: (line) => warned.push(line),
      now: () => "2026-07-29T01:00:05.000Z",
      // A daemon that cannot possibly start: the host is simply not there.
      client: { serverCommand: join(cwd, "no-such-daemon"), readyTimeoutMs: 200 },
    });

    expect(code).toBe(0);
    expect(written).toEqual([`${REDSKILLED_RENDER_ABSENCE}\n`]);
    // The diagnosis is not lost — it goes where a statusline does not show it.
    expect(warned.join("")).toContain("redskilled statusline:");
  });
});
