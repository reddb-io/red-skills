// One Worker, one log lane — resolved at BIRTH, and loud when it cannot be (#3440).
//
// Three failures with one root: a log path is a long-lived string that names a
// short-lived thing.
//
//   - A dispatch could not name `workers/<id>/` because the host mints the id,
//     so it stamped a dated path of its own and `/go` ended up on a different
//     lane in a different format from `/afk`. The placeholder the registration
//     lane already used was the answer; the direct lane simply never expanded it.
//   - A registration is renewed for days, so the `log_path` it hands out is the
//     one recorded when it was first registered. A Worker that died on
//     2026-08-06 reported a path under a date-dir minted on 2026-08-05 — which
//     the janitor's TTL was concurrently reclaiming.
//   - `prepareWorkerLog` swallowed its `mkdirSync` failure, so a Worker launched
//     with no log at all and nothing anywhere said why — and its death event
//     still named the file nobody had opened, so the absence read as a deleted
//     directory rather than as a log that was never created.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { expandWorkerLogPath, RedskilledLaunchFactError } from "../src/launch-template.js";
import { launchWorker, type RedskilledWorkerSpec } from "../src/worker-launch.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A Worker that exits immediately; every assertion here is about its birth. */
function exitingSpec(workspacePath: string, overrides: Partial<RedskilledWorkerSpec> = {}): RedskilledWorkerSpec {
  return {
    project_label: "acme/widgets",
    workspace_path: workspacePath,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    ...overrides,
  };
}

function admittedLaunch(spec: RedskilledWorkerSpec) {
  return launchWorker({
    spec,
    admission: evaluateWorkerAdmission({
      ceiling: UNBOUNDED_HOST_CEILING,
      workers: [],
      ...(spec.budget === undefined ? {} : { budget: spec.budget }),
      ...(spec.project_label === undefined ? {} : { projectLabel: spec.project_label }),
    }),
  });
}

describe("expandWorkerLogPath", () => {
  it("writes this birth's id into the path the client declared", () => {
    expect(
      expandWorkerLogPath("/repo/.red/tmp/workers/{{worker_id}}/worker.log.toonl", {
        worker_id: "hAB12",
        workspace_path: "/repo",
      }),
    ).toBe("/repo/.red/tmp/workers/hAB12/worker.log.toonl");
  });

  it("returns a literal path unchanged, so an already-expanded one survives a second pass", () => {
    expect(
      expandWorkerLogPath("/repo/.red/tmp/workers/hAB12/worker.log.toonl", {
        worker_id: "hZZ99",
        workspace_path: "/repo",
      }),
    ).toBe("/repo/.red/tmp/workers/hAB12/worker.log.toonl");
  });

  it("treats an absent or blank declaration as no declaration", () => {
    const facts = { worker_id: "hAB12", workspace_path: "/repo" };
    expect(expandWorkerLogPath(undefined, facts)).toBeUndefined();
    expect(expandWorkerLogPath("   ", facts)).toBeUndefined();
  });

  it("refuses a fact the direct lane does not own rather than fabricating one", () => {
    expect(() =>
      expandWorkerLogPath("/repo/logs/slot-{{slot}}.log", { worker_id: "hAB12", workspace_path: "/repo" }),
    ).toThrow(RedskilledLaunchFactError);
  });
});

describe("a Worker's log path is resolved at birth", () => {
  it("expands {{worker_id}} to the id this launch actually minted", async () => {
    const workspace = await scratch("redskilled-birth-log-");
    const launched = admittedLaunch(
      exitingSpec(workspace, { log_path: join(workspace, "workers", "{{worker_id}}", "worker.log.toonl") }),
    );

    const expected = join(workspace, "workers", launched.worker.worker_id, "worker.log.toonl");
    expect(launched.worker.log_path).toBe(expected);
    expect(existsSync(join(workspace, "workers", launched.worker.worker_id))).toBe(true);
  });

  it("hands two Workers of one declaration two different files", async () => {
    const workspace = await scratch("redskilled-birth-log-");
    const declared = join(workspace, "workers", "{{worker_id}}", "worker.log.toonl");
    const first = admittedLaunch(exitingSpec(workspace, { log_path: declared }));
    const second = admittedLaunch(exitingSpec(workspace, { log_path: declared }));

    expect(first.worker.log_path).not.toBe(second.worker.log_path);
  });
});

describe("a failed mkdir speaks", () => {
  it("warns with the path and the errno instead of running silently unlogged", async () => {
    const workspace = await scratch("redskilled-birth-log-");
    const sealed = await scratch("redskilled-sealed-");
    await chmod(sealed, 0o500);
    const denied = join(sealed, "nested", "worker.log.toonl");

    const launched = admittedLaunch(exitingSpec(workspace, { log_path: denied }));

    const warning = launched.warnings.find((line) => line.includes("log directory"));
    expect(warning).toBeDefined();
    expect(warning).toContain(join(sealed, "nested"));
    expect(warning).toContain("EACCES");
    expect(launched.worker.warnings).toContain(warning);
  });

  it("does not name a log nobody opened, so a death event cannot point at an absent file", async () => {
    const workspace = await scratch("redskilled-birth-log-");
    const sealed = await scratch("redskilled-sealed-");
    await chmod(sealed, 0o500);

    const launched = admittedLaunch(
      exitingSpec(workspace, { log_path: join(sealed, "nested", "worker.log.toonl") }),
    );

    expect(launched.worker.log_path).toBeUndefined();
  });
});
