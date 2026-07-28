// The MCP lane canary, driven against real processes over the real MCP stdio
// transport (#2706, ADR 0128 §7).
//
// This is the file that makes the canary a canary. It runs the SAME production
// walk twice against two sandboxes that differ in exactly one byte-level fact —
// whether the bundle beside the MCP entry can route `run` — and requires:
//
//   healthy    -> green, with a worker directory and a live worker pid
//   unroutable -> RED at `worker_spawn`, reproducing #2677
//
// A canary that cannot catch its own motivating bug is not a canary, so the red
// case is an assertion, not a smoke test.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { runMcpLaneCanary } from "../src/core/mcp-lane-canary.js";
import { connectMcpLaneCanary } from "../src/runtime/mcp-lane-canary-io.js";
import {
  cleanupCanarySandboxes,
  createCanarySandbox,
  type CanaryLaneVariant,
} from "./fixtures/mcp-lane-canary/sandbox.js";

// Bundling three entries and driving two live process trees; be generous.
const TIMEOUT = 180_000;

async function walk(variant: CanaryLaneVariant, workerDeadlineMs = 20_000) {
  const sandbox = await createCanarySandbox(variant);
  const transport = await connectMcpLaneCanary({
    args: [sandbox.mcpEntry],
    cwd: sandbox.root,
    env: sandbox.env,
  });
  try {
    const result = await runMcpLaneCanary(transport, {
      fleet: "canary",
      runner: "claude",
      target: 1,
      workerDeadlineMs,
      teardownDeadlineMs: 20_000,
      pollMs: 150,
    });
    return { result, stderr: transport.stderr(), sandbox };
  } finally {
    await transport.close();
  }
}

afterAll(async () => {
  await cleanupCanarySandboxes();
});

describe("MCP lane canary over the real transport", () => {
  it(
    "goes green when the slot entry routes `run`, on evidence of a live worker",
    async () => {
      const { result } = await walk("healthy");

      expect(result.inertStep).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.steps.map((step) => step.verdict)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ]);
      // Not "fleet_create returned a pid" — an actual worker directory holding
      // an actual live pid, which is the thing #2677's dead slots never wrote.
      expect(result.workers.length).toBeGreaterThan(0);
      const worker = result.workers[0]!;
      expect(worker.alive).toBe(true);
      expect(worker.pid).toBeGreaterThan(0);
      expect(worker.dir).toContain("/.red/tmp/workers/");
      expect(result.supervisorPid).toBeGreaterThan(0);
      // A probe that leaks a live fleet is worse than no probe.
      expect(isLive(result.supervisorPid!)).toBe(false);
      expect(isLive(worker.pid!)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "goes RED at worker_spawn against a bundle whose slot entry cannot route `run` (#2677)",
    async () => {
      // Every slot dies on spawn here, so a short deadline is enough — the
      // failure is deterministic, not a race the canary might lose.
      const { result, stderr } = await walk("unroutable", 8_000);

      expect(result.ok).toBe(false);
      expect(result.inertStep).toBe("worker_spawn");
      // The lane looked healthy right up to the step that matters: the tools
      // answered, the fleet launched, the supervisor lived. That is exactly why
      // #2677 survived unnoticed, and exactly what the canary must name.
      const byStep = new Map(result.steps.map((step) => [step.step, step.verdict]));
      expect(byStep.get("connect")).toBe("ok");
      expect(byStep.get("fleet_create")).toBe("ok");
      expect(byStep.get("supervisor_live")).toBe("ok");
      expect(byStep.get("worker_spawn")).toBe("inert");
      expect(result.workers).toHaveLength(0);
      // The failure output names the step that went inert and why.
      expect(result.summary).toContain("worker_spawn");
      expect(result.summary).toContain("cannot route `run`");
      expect(stderr).not.toContain("secret");
      // An inert lane is still torn down: the canary never leaves the fleet it
      // created running just because it failed.
      expect(result.steps.find((step) => step.step === "fleet_stop")?.verdict).toBe("ok");
      expect(isLive(result.supervisorPid!)).toBe(false);
    },
    TIMEOUT,
  );
});

describe("the shipped castle-mcp bundle carries the canary", () => {
  // Source-level greens are exactly what #2677 had. The probe must also work
  // from the built artifact operators and CI actually run, whose bundled
  // dependency graph differs from the source tree's.
  it(
    "runs `__mcp-canary` out of the built bundle and reports a green lane",
    async () => {
      const run = promisify(execFile);
      const appRoot = join(import.meta.dirname, "..");
      await run("pnpm", ["run", "bundle:mcp"], {
        cwd: appRoot,
        env: {
          ...process.env,
          RED_BUILD_VERSION: "0.0.0-test",
          RED_BUILD_GIT_SHA: "test",
          RED_BUILD_TIME: "2026-01-01T00:00:00.000Z",
        },
      });
      const bundle = join(appRoot, "..", "..", "dist", "castle-mcp.bundle.min.mjs");
      const sandbox = await createCanarySandbox("healthy");

      const { stdout } = await run(
        process.execPath,
        [
          bundle,
          "__mcp-canary",
          "--entry",
          sandbox.mcpEntry,
          "--root",
          sandbox.root,
          "--fleet",
          "canary",
          "--worker-deadline-ms",
          "20000",
        ],
        { cwd: sandbox.root, env: sandbox.env },
      );

      const report = decode(stdout.trim()) as { ok: boolean; inert_step?: string };
      expect(report.inert_step).toBeUndefined();
      expect(report.ok).toBe(true);
    },
    TIMEOUT,
  );
});

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
