// The MCP lane canary, driven against real processes over the real MCP stdio
// transport (#2706, ADR 0128 §7).
//
// This is the file that makes the canary a canary. It runs the SAME production
// walk against real sandboxes that differ in exactly one fact each, and
// requires:
//
//   daemon up   -> green: a registration the daemon holds, and no process of
//                  the project's own anywhere under it
//   daemon down -> RED at `project_start`, naming the socket (ADR 0130 rule 6)
//
// Under ADR 0130 Amendment 3 (#2902) the project no longer resolves a slot entry
// at all — it registers an argv and the host runs it. So #2677's byte-level
// fact, whether the bundle beside the entry can route `run`, moved into the
// REGISTERED argv, asserted in the step contract (mcp-lane-canary.test.ts). The
// fixture keeps building its `unroutable` dev bundle: the assertion that a
// Worker born from that argv boots into nothing belongs to the slice where the
// daemon drives the registration.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { runMcpLaneCanary } from "../src/core/mcp-lane-canary.js";
import {
  connectMcpLaneCanary,
  resolveCanarySocketPath,
} from "../src/runtime/mcp-lane-canary-io.js";
import {
  cleanupCanarySandboxes,
  createCanarySandbox,
  type CanaryDaemonState,
  type CanaryLaneVariant,
} from "./fixtures/mcp-lane-canary/sandbox.js";

// Bundling four entries and driving live process trees; be generous.
const TIMEOUT = 180_000;

async function walk(
  variant: CanaryLaneVariant,
  quietDeadlineMs = 3_000,
  daemon: CanaryDaemonState = "up",
) {
  const sandbox = await createCanarySandbox(variant, daemon);
  // Resolved from the sandbox's own env, so the path the canary names is the
  // path this sandbox's daemon does or does not listen on.
  const socketPath = await resolveCanarySocketPath(sandbox.env);
  const transport = await connectMcpLaneCanary({
    args: [sandbox.mcpEntry],
    cwd: sandbox.root,
    env: sandbox.env,
  });
  try {
    const result = await runMcpLaneCanary(transport, {
      runner: "claude",
      target: 1,
      quietDeadlineMs,
      teardownDeadlineMs: 20_000,
      // The sandbox daemon polls and ticks every 300ms, so a walk that needed
      // longer than this is one where the loop did not run at all.
      demandDeadlineMs: 30_000,
      pollMs: 150,
      ...(socketPath !== undefined ? { socketPath } : {}),
    });
    return { result, stderr: transport.stderr(), sandbox, socketPath };
  } finally {
    await transport.close();
  }
}

afterAll(async () => {
  await cleanupCanarySandboxes();
});

describe("MCP lane canary over the real transport", () => {
  it(
    "goes green on registration -> one poll covering it -> a Worker the daemon birthed",
    async () => {
      const { result, stderr, sandbox } = await walk("healthy");

      expect(result.inertStep).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.steps.map((step) => step.verdict)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ]);
      // Not "project_start answered" — a registration the daemon minted, naming
      // this project and carrying the argv the host would run for it.
      const registration = result.registration!;
      expect(registration.project).not.toBe("");
      expect(registration.renewBy).not.toBe("");
      // A query the TRACKER can answer, not the project's own selector shape:
      // the daemon hands this string over verbatim, so `{}` was a question about
      // nothing that counted nothing and birthed nothing (#2974).
      expect(registration.selector).toBe(
        'repo:acme/canary is:issue is:open label:"ready-for-agent"',
      );
      expect(registration.argv).toContain("run");
      expect(registration.argv.join(" ")).toContain("--runner claude");
      // The daemon really asked the tracker, in one aliased request, and really
      // counted this project in it.
      expect(result.poll?.outcome).toBe("counted");
      expect(result.poll?.requestCount).toBe(1);
      expect(sandbox.trackerRequests()).toBeGreaterThan(0);
      // And then acted on what it counted: a Worker this project never spawned,
      // running out of the argv the registration stated.
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0]!.alive).toBe(true);
      expect(stderr).not.toContain("secret");
    },
    TIMEOUT,
  );
});

describe("the socket boundary the lane grew under ADR 0130 (#2794, #2851)", () => {
  it(
    "goes RED at project_start when no daemon answers, and starts nothing at all",
    async () => {
      // Identical to the green walk in every byte except one: no daemon is
      // listening on this sandbox's session socket.
      //
      // Before the cutover (#2851) this walk got as far as `daemon_reach`: the
      // project spawned its own workers, so the lane produced a live worker it
      // could not vouch for. Now that the daemon owns every birth, the failure
      // moved EARLIER and got louder — the start itself refuses, because a
      // project the host never registered is work nothing will ever drive.
      // Failing at the start is the stronger signal: nothing was started, so
      // there is no unvouched worker left running to reason about.
      const { result, socketPath } = await walk("healthy", 3_000, "down");

      expect(result.ok).toBe(false);
      expect(result.inertStep).toBe("project_start");
      const byStep = new Map(result.steps.map((step) => [step.step, step.verdict]));
      expect(byStep.get("connect")).toBe("ok");
      expect(byStep.get("project_start")).toBe("inert");
      // Nothing downstream ran, and nothing downstream needed to.
      expect(byStep.get("registration_held")).toBe("skipped");
      expect(byStep.get("no_project_process")).toBe("skipped");
      expect(byStep.get("queue_polled")).toBe("skipped");
      expect(byStep.get("worker_born")).toBe("skipped");
      expect(result.workers).toHaveLength(0);
      // Loudly, and naming the socket rather than the tool: the operator's next
      // move is on that path, and "project_start failed" alone would send them
      // to the wrong process entirely.
      expect(result.summary).toContain("project_start");
      expect(result.summary).toContain("redskilled");
      expect(socketPath).toBeTruthy();
      expect(result.summary).toContain(socketPath!);
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
          "--quiet-deadline-ms",
          "3000",
          "--demand-deadline-ms",
          "30000",
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

// Deliberately LAST in the file: the closing case runs the harness's own
// cleanup, which drops the shared bundle cache every earlier test reuses.
describe("the canary's daemon lives in a runtime directory the sandbox owns (#2884)", () => {
  it(
    "writes its socket, lease and lane outside the operator's runtime directory",
    async () => {
      const sandbox = await createCanarySandbox("healthy");
      const paths = resolveRedskilledPaths({ env: sandbox.env });

      // The daemon really ran, and really ran HERE — an isolation claim that
      // held only because nothing was started would prove nothing.
      expect(paths.runtimeDir.startsWith(`${sandbox.runtimeRoot}/`)).toBe(true);
      expect(existsSync(paths.socketPath)).toBe(true);
      expect(existsSync(paths.leasePath)).toBe(true);

      // The path this sandbox WOULD have used before the fix: same session key,
      // the operator's real environment. Nothing may exist there. This is a pure
      // function of the session key, so it names the one directory this sandbox
      // could have littered rather than diffing a directory other tests share.
      const strayed = resolveRedskilledPaths({
        env: { ...process.env, REDSKILLED_SESSION: sandbox.env.REDSKILLED_SESSION },
      });
      expect(strayed.runtimeDir).not.toBe(paths.runtimeDir);
      expect(existsSync(strayed.runtimeDir)).toBe(false);

      // The isolation the fixture depends on survives the move: two sandboxes
      // still land on two runtime directories, so an `up` sandbox can never be
      // served by another sandbox's daemon.
      const other = await createCanarySandbox("healthy", "down");
      expect(resolveRedskilledPaths({ env: other.env }).runtimeDir).not.toBe(paths.runtimeDir);
    },
    TIMEOUT,
  );

  it(
    "leaves no runtime directory behind when a walk fails mid-way",
    async () => {
      const sandbox = await createCanarySandbox("healthy");
      const paths = resolveRedskilledPaths({ env: sandbox.env });
      expect(existsSync(paths.socketPath)).toBe(true);

      // A walk that throws never reaches its own teardown; the harness's
      // `afterAll` is the only thing that runs, so that is what is exercised.
      await cleanupCanarySandboxes();

      expect(existsSync(sandbox.runtimeRoot)).toBe(false);
      expect(existsSync(sandbox.root)).toBe(false);
      expect(existsSync(paths.runtimeDir)).toBe(false);
    },
    TIMEOUT,
  );
});
