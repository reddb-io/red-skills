// The inner agent's `gh` process is part of the Worker's GitHub budget (#3269).
// It must cross the same reserved-band and quota-backoff boundaries as engine
// calls, and every invocation must be attributable to the Worker that issued it.
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubAttributionLedger } from "@reddb-io/github";

import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import type { GhBandGate } from "../src/runtime/gh/band.js";
import {
  WORKER_GH_ACTOR_ENV,
  WORKER_GH_REAL_ENV,
  installWorkerGhBoundary,
  runWorkerGhBoundary,
} from "../src/runtime/worker-gh-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worker-gh-boundary-"));
  roots.push(root);
  return root;
}

function ledger(records: Array<Record<string, unknown>>): GithubAttributionLedger {
  return {
    async record(input) {
      records.push(input as unknown as Record<string, unknown>);
    },
    async report() {
      throw new Error("not used");
    },
  };
}

const OPEN_BAND: GhBandGate = { async admit() { return null; } };

describe("the Worker's gh PATH boundary", () => {
  it("installs a gh shim ahead of the real binary without changing the worktree", async () => {
    const root = await scratch();
    const installed = await installWorkerGhBoundary({
      workerRoot: root,
      path: "/usr/local/bin:/usr/bin",
      realGh: "/usr/bin/gh",
      node: "/runtime/node",
      entry: "/bundle/dev.mjs",
      actor: "worker:wBOUND",
    });

    expect(installed.env.PATH!.split(":")[0]).toBe(join(root, "github-boundary", "bin"));
    expect(installed.env[WORKER_GH_REAL_ENV]).toBe("/usr/bin/gh");
    expect(installed.env[WORKER_GH_ACTOR_ENV]).toBe("worker:wBOUND");
    await expect(access(installed.shimPath)).resolves.toBeUndefined();
    expect(await readFile(installed.shimPath, "utf8")).toContain(
      "exec '/runtime/node' '/bundle/dev.mjs' worker-gh \"$@\"",
    );
  });

  it("refuses a convenience call before the real gh process can spend", async () => {
    const exec = vi.fn<ExecFn>();
    const band: GhBandGate = {
      async admit() {
        return {
          admission: {
            admitted: false,
            posture: "reserved",
            pool: "graphql",
            criticality: "convenience",
            remaining: 100,
            reserved_floor: 250,
            reset_at: "2026-08-04T18:00:00.000Z",
            reason: "inside the reserved band",
          },
          message: "gh issue comment 42 --body sensitive-body was not issued: inside the reserved band",
        };
      },
    };

    const result = await runWorkerGhBoundary(["issue", "comment", "42", "--body", "sensitive-body"], {
      env: { [WORKER_GH_REAL_ENV]: "/usr/bin/gh", [WORKER_GH_ACTOR_ENV]: "worker:wBOUND" },
      exec,
      band,
      attribution: ledger([]),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("reserved band");
    expect(result.stderr).not.toContain("sensitive-body");
    expect(exec).not.toHaveBeenCalled();
  });

  it("retries quota refusals and attributes every real invocation to its Worker", async () => {
    const records: Array<Record<string, unknown>> = [];
    const responses: ExecOutput[] = [
      { code: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded" },
      { code: 0, stdout: "[]\n", stderr: "" },
    ];
    const exec = vi.fn<ExecFn>(async () => responses.shift()!);

    const result = await runWorkerGhBoundary(["issue", "list", "--json", "number"], {
      env: { [WORKER_GH_REAL_ENV]: "/usr/bin/gh", [WORKER_GH_ACTOR_ENV]: "worker:wBOUND" },
      exec,
      band: OPEN_BAND,
      attribution: ledger(records),
      quotaBackoff: {
        nowMs: (() => { let now = 0; return () => now++; })(),
        sleepMs: async () => {},
        capMs: 10,
        defaultWaitMs: 1,
      },
    });

    expect(result).toEqual({ code: 0, stdout: "[]\n", stderr: "" });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith("/usr/bin/gh", ["issue", "list", "--json", "number"], expect.any(Object));
    expect(records).toEqual([
      { operation: expect.objectContaining({ key: "issue list", budget: "graphql" }), cost: 1, actor: "worker:wBOUND" },
      { operation: expect.objectContaining({ key: "issue list", budget: "graphql" }), cost: 1, actor: "worker:wBOUND" },
    ]);
  });

  it("fails closed when the agent asks for an unclassified gh operation", async () => {
    const exec = vi.fn<ExecFn>();
    const result = await runWorkerGhBoundary(["gist", "create", "--desc", "sensitive-body"], {
      env: { [WORKER_GH_REAL_ENV]: "/usr/bin/gh", [WORKER_GH_ACTOR_ENV]: "worker:wBOUND" },
      exec,
      band: OPEN_BAND,
      attribution: ledger([]),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unclassified GitHub operation");
    expect(result.stderr).not.toContain("sensitive-body");
    expect(exec).not.toHaveBeenCalled();
  });
});
