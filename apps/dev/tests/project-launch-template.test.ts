// A Worker's runner, model and effort are decided per birth, and ADR 0130
// Amendment 4 hands the daemon one argv per project. What is proven here is the
// project's half of Amendment 5: a tick states the launch its NEXT Worker is
// started with, a runner directive changes it without anything restarting, the
// slot-scoped env is stated as placeholders rather than as values, and per-tier
// model and effort still resolve for a Worker born from that launch.
import { describe, expect, it } from "vitest";
import { expandLaunchTemplate } from "@reddb-io/redskilled/launch-template";
import { resolveTier, type ConfigValues } from "../src/core/config.js";
import { buildProjectLaunchTemplate } from "../src/core/supervisor/launch-template.js";

const BASE = {
  bundleArgv: ["/usr/bin/node", "/bundle.mjs"],
  workerEnv: { PATH: "/usr/bin", RED_AFK_RUNNER: "claude", RED_AFK_SWEEPS_DONE: "1" },
  retireDir: "/state",
} as const;

/** The runner word the daemon will start this Worker with, read off the argv. */
function runnerOf(argv: readonly string[]): string {
  return argv[argv.indexOf("--runner") + 1]!;
}

/** No config file at all: every tier resolves from the shipped table. */
const NO_CONFIG: ConfigValues = {};

describe("the launch a project states for its next Worker", () => {
  it("carries the runner this tick decided, in the argv and in the env", () => {
    const template = buildProjectLaunchTemplate({ ...BASE, runner: "claude", slotArgs: ["--spec-only"] });

    expect(template.argv).toEqual([
      "/usr/bin/node",
      "/bundle.mjs",
      "run",
      "--once",
      "--runner",
      "claude",
      "--spec-only",
    ]);
    // Re-pinned rather than inherited: the passthrough env carried a runner from
    // before the directive, and the Worker's detection cascade must read this one.
    expect(template.env!.RED_AFK_RUNNER).toBe("claude");
  });

  it("changes the runner of the next Worker when a directive lands mid-drain", () => {
    // The drain started on claude and the runner degraded. Nothing restarts: the
    // tick states a new launch, and the next Worker is born on the new runner.
    const before = buildProjectLaunchTemplate({ ...BASE, runner: "claude" });
    const after = buildProjectLaunchTemplate({ ...BASE, runner: "codex" });

    expect(runnerOf(before.argv)).toBe("claude");
    expect(runnerOf(after.argv)).toBe("codex");
    expect(after.env!.RED_AFK_RUNNER).toBe("codex");
    // Only the runner moved: a swap must not quietly restate the run's flags.
    expect(after.argv.filter((word) => word !== "codex")).toEqual(
      before.argv.filter((word) => word !== "claude"),
    );
  });

  it("states the per-birth facts as placeholders, so one launch serves every slot", () => {
    const template = buildProjectLaunchTemplate({ ...BASE, runner: "claude" });

    expect(template.env!.RED_AFK_SLOT).toBe("{{slot}}");
    expect(template.env!.RED_AFK_WORKER_ID).toBe("{{worker_id}}");
    expect(template.env!.RED_AFK_RETIRE_FILE).toBe("/state/afk-supervisor-slot-{{slot}}.retire");

    // Two births off the ONE template, and every per-slot value differs — a
    // retire file two Workers shared would retire the wrong one.
    const first = expandLaunchTemplate(template, { worker_id: "wAAAA", slot: 0, workspace_path: "/repo" });
    const second = expandLaunchTemplate(template, { worker_id: "wBBBB", slot: 1, workspace_path: "/repo" });
    expect(first.env.RED_AFK_SLOT).toBe("0");
    expect(second.env.RED_AFK_SLOT).toBe("1");
    expect(first.env.RED_AFK_WORKER_ID).toBe("wAAAA");
    expect(second.env.RED_AFK_WORKER_ID).toBe("wBBBB");
    expect(first.env.RED_AFK_RETIRE_FILE).toBe("/state/afk-supervisor-slot-0.retire");
    expect(second.env.RED_AFK_RETIRE_FILE).toBe("/state/afk-supervisor-slot-1.retire");
  });

  it("carries the tier downgrade a policy asked for, and drops it when it did not", () => {
    const downgraded = buildProjectLaunchTemplate({ ...BASE, runner: "claude", taskTierDowngrade: true });
    const ordinary = buildProjectLaunchTemplate({ ...BASE, runner: "claude" });

    expect(downgraded.env!.RED_AFK_TASK_TIER_DOWNGRADE).toBe("1");
    expect(ordinary.env).not.toHaveProperty("RED_AFK_TASK_TIER_DOWNGRADE");
  });

  it("carries every word of a multi-word bundle invocation", () => {
    // A host with no bundle on disk resolves to a version-pinned dispatch, which
    // is a command followed by SEVERAL words. An interpreter/bundle pair would
    // have dropped everything after the first argument.
    const template = buildProjectLaunchTemplate({
      ...BASE,
      bundleArgv: ["/usr/bin/npx", "-y", "-p", "@reddb-io/red-skills@1.2.3", "red-skills-dev"],
      runner: "claude",
    });
    expect(template.argv.slice(0, 6)).toEqual([
      "/usr/bin/npx",
      "-y",
      "-p",
      "@reddb-io/red-skills@1.2.3",
      "red-skills-dev",
      "run",
    ]);
  });

  it("states where the next Worker logs, so a restatement cannot clear it", () => {
    // Restating a launch is all-or-nothing: a renewal carrying an argv and no log
    // path clears the one the registration declared (#3079), and the Worker born
    // from it reaches every surface with nothing to show.
    const template = buildProjectLaunchTemplate({
      ...BASE,
      runner: "claude",
      logPath: "/repo/.red/tmp/logs/2026-08-03/worker-{{worker_id}}.log",
    });
    expect(template.log_path).toBe("/repo/.red/tmp/logs/2026-08-03/worker-{{worker_id}}.log");
    const born = expandLaunchTemplate(template, { worker_id: "wAAAA", slot: 0, workspace_path: "/repo" });
    expect(born.log_path).toBe("/repo/.red/tmp/logs/2026-08-03/worker-wAAAA.log");
  });

  it("carries a reconcile Ticket when a tick asks for a reconcile Worker", () => {
    const template = buildProjectLaunchTemplate({ ...BASE, runner: "claude", reconcileIssue: 2949 });
    expect(template.argv).toContain("--reconcile-issue");
    expect(template.argv[template.argv.indexOf("--reconcile-issue") + 1]).toBe("2949");
  });
});

describe("model and effort, for a Worker born through the daemon", () => {
  it("resolves per tier from the runner the launch carries, not from the launch", () => {
    // No model and no effort appear anywhere in the launch, on purpose: they
    // resolve per tier, per run, inside the Worker. What the launch owes them is
    // the one input they take from outside — the runner.
    const template = buildProjectLaunchTemplate({ ...BASE, runner: "claude" });
    expect(template.argv.join(" ")).not.toContain("--model");
    expect(template.argv.join(" ")).not.toContain("--effort");

    const born = expandLaunchTemplate(template, { worker_id: "wAAAA", slot: 0, workspace_path: "/repo" });
    const runner = runnerOf(born.argv);

    // Every tier still resolves, and they are not all the same answer — which is
    // what "per tier" means and what a frozen model would have flattened.
    expect(resolveTier(NO_CONFIG, runner, "validate", born.env)).toEqual({
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(resolveTier(NO_CONFIG, runner, "think", born.env)).toEqual({
      model: "claude-opus-4-8",
      effort: "high",
    });
  });

  it("follows the runner across a swap, so the next Worker resolves the new runner's tiers", () => {
    const swapped = buildProjectLaunchTemplate({ ...BASE, runner: "codex" });
    const born = expandLaunchTemplate(swapped, { worker_id: "wBBBB", slot: 0, workspace_path: "/repo" });

    expect(resolveTier(NO_CONFIG, runnerOf(born.argv), "validate", born.env).model).toBe("gpt-5.5");
    // The runner in the env agrees with the runner in the argv; a Worker whose
    // detection cascade read one and whose tier table read the other would run a
    // model its own CLI never accepted.
    expect(born.env.RED_AFK_RUNNER).toBe(runnerOf(born.argv));
  });

  it("honours a tier downgrade composed into the birth env", () => {
    const template = buildProjectLaunchTemplate({ ...BASE, runner: "claude", taskTierDowngrade: true });
    const born = expandLaunchTemplate(template, { worker_id: "wCCCC", slot: 2, workspace_path: "/repo" });

    // The downgrade is a per-birth decision that reaches the tier table through
    // the env the launch composed — one tier down from `think`.
    const downgraded = resolveTier(NO_CONFIG, runnerOf(born.argv), "think", born.env);
    const undowngraded = resolveTier(NO_CONFIG, runnerOf(born.argv), "think", {});
    expect(downgraded).not.toEqual(undowngraded);
    expect(downgraded).toEqual(resolveTier(NO_CONFIG, "claude", "complex", {}));
  });
});
