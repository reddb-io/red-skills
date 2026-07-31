// The local statusline mode answers for the CALLING DIRECTORY's project (#2928).
//
// The bug this file pins had one shape and two halves. A repository that
// declares no `project.name` — most of them — got its Workers filed under the
// label the git remote gives, because that is what the birth path resolves; the
// statusline resolved only the DECLARED name, found none, and asked the daemon
// about no project at all. The daemon answered honestly for the question it was
// asked, and the operator read `project unknown 0w … idle` off a host holding
// three of that very repository's Workers.
//
// So the first test here builds exactly that: a three-Worker host, a checkout
// with a remote and no declared name, and the local mode invoked inside it. The
// second half is the distinction the first one has to make afterwards — an idle
// registered project and an unmatched directory are opposite facts and must not
// render as the same calm zero.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { runStatusline } from "../src/cli.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { buildStatuslinePayload } from "../src/statusline-payload.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineOptions,
} from "../src/statusline-render.js";

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
  const root = await scratch("redskilled-statusline-local-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "reddb-io/red-skills",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/red-skills/w-1",
    isolated: true,
    unit: "red-worker-w-1.service",
    budget: { memory_max: "1G" },
    warnings: [],
    ...overrides,
  };
}

function options(overrides: Partial<RedskilledStatuslineOptions> = {}): RedskilledStatuslineOptions {
  return { ...REDSKILLED_STATUSLINE_DEFAULTS, ...overrides };
}

/**
 * A checkout that names itself the way most repositories do: through its remote.
 *
 * `.red/config.yaml` carries plugin taste and NO `project.name`, which is the
 * ordinary case and the one the old resolver could not read.
 */
async function checkoutWithRemote(remote: string, configLines: readonly string[] = []): Promise<string> {
  const root = await scratch("redskilled-statusline-checkout-");
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: root, stdio: "ignore" });
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), `${["plugins:", "  dev:", "    enabled: true", ...configLines].join("\n")}\n`, "utf8");
  return root;
}

describe("the local statusline mode, invoked inside a registered project", () => {
  it("lists that project's Workers instead of reporting an idle zero", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({
        rss: { "w-1": 7 * MB, "w-2": 7 * MB, "w-3": 7 * MB },
        cpu_seconds: {},
      }),
    });
    running.push(daemon);
    // Three Workers, all filed under the label the REMOTE gives — exactly how the
    // birth path labels them for a repository that declares no name.
    for (const id of ["w-1", "w-2", "w-3"]) {
      daemon.trackWorker(worker({ worker_id: id, pid: 4242 + Number(id.slice(2)), workspace_path: `/tmp/red-skills/${id}` }));
    }
    await daemon.sampleMemoryBudgets();

    const cwd = await checkoutWithRemote("git@github.com:reddb-io/red-skills.git");
    const written: string[] = [];
    const code = await runStatusline([], { cwd, paths, write: (line) => written.push(line), warn: () => undefined });

    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    // The regression, stated as the thing that must NOT be there: the answer this
    // fixture produced before #2928 was `project unknown 0w 0B idle`.
    expect(written[0]).not.toContain("project unknown");
    expect(written[0]).not.toContain("idle");
    expect(written[0]).toContain("reddb-io/red-skills 3w");
    for (const id of ["w-1", "w-2", "w-3"]) expect(written[0]).toContain(id);
  });

  it("prefers a declared `project.name` over the remote, as the birth path does", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: { "w-1": 7 * MB }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker({ project_label: "acme/declared" }));
    await daemon.sampleMemoryBudgets();

    const cwd = await checkoutWithRemote("git@github.com:reddb-io/red-skills.git", [
      "project:",
      "  name: acme/declared",
    ]);
    const written: string[] = [];
    const code = await runStatusline([], { cwd, paths, write: (line) => written.push(line), warn: () => undefined });

    expect(code).toBe(0);
    expect(written[0]).toContain("acme/declared 1w");
  });
});

describe("`project unknown`", () => {
  /** A payload the daemon would build from this Worker set and these registrations. */
  function payloadOf(
    workers: readonly RedskilledWorkerView[],
    registrations: readonly string[] = [],
  ) {
    return buildStatuslinePayload({
      hostState: buildHostState({
        daemonVersion: "0.1.0",
        machineIdHash: "mach",
        sessionKeyHash: "sess",
        pid: 99,
        startedAt: "2026-07-29T00:00:00.000Z",
        workers,
        registrations: registrations.map((project_label) => ({
          version: 1 as const,
          project_label,
          selector: "opaque",
          argv: ["opaque"],
          workspace_path: "/tmp/opaque",
          target: 1,
          registered_at: "2026-07-29T00:00:00.000Z",
          renew_within_ms: 60_000,
          renew_by: "2026-07-29T00:01:00.000Z",
        })),
      }),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: "2026-07-29T01:00:00.000Z",
      now: "2026-07-29T01:00:05.000Z",
    });
  }

  it("stays away from a registered project that simply has no Workers right now", () => {
    const render = renderRedskilledStatusline(
      payloadOf([], ["acme/widgets"]),
      options({ project: "acme/widgets" }),
    );

    expect(render.project_match).toBe("matched");
    expect(render.line).not.toContain("project unknown");
    // An idle project says so, which is the fact `project unknown` must never
    // stand in for: one means "nothing running", the other "nobody knows you".
    expect(render.line).toContain("acme/widgets 0w");
    expect(render.line).toContain("idle");
  });

  it("names the mismatch when the directory resolved to a project this host never heard of", () => {
    const render = renderRedskilledStatusline(
      payloadOf([worker({ project_label: "acme/other" })]),
      options({ project: "acme/widgets" }),
    );

    expect(render.project_match).toBe("unregistered");
    expect(render.line).toContain("project unknown");
    expect(render.line).toContain("acme/widgets is not registered on this host");
    // No idle zero to read as calm — the host may be busy for someone else.
    expect(render.line).not.toContain("0w");
    expect(render.line).not.toContain("idle");
  });

  it("says so plainly when the directory resolved to no project at all", () => {
    const render = renderRedskilledStatusline(payloadOf([]), options({ project: null }));

    expect(render.project_match).toBe("unresolved");
    expect(render.line).toContain("project unknown — this directory resolved to no project");
    expect(render.line).not.toContain("0w");
  });

  it("never accuses a project when the daemon is too old to have an opinion", () => {
    const payload = payloadOf([], ["acme/widgets"]);
    const { known_projects: _dropped, ...older } = payload;
    const render = renderRedskilledStatusline(older, options({ project: "acme/widgets" }));

    // A missing field is a daemon that cannot say, not a host that said no.
    expect(render.project_match).toBe("matched");
    expect(render.line).not.toContain("project unknown");
  });
});
