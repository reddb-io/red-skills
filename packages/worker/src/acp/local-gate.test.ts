// The gate the Worker runs in its own Worktree (issue #4020).
//
// Two things are worth proving with real files: the workspace topology this
// reads off disk decides which packages the cone validates, and a stage with
// nothing to run is SKIPPED rather than green — the difference between "the
// review passed" and "no reviewer was wired" is the whole of ADR 0135.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateVerdict } from "../engine/gate-stage-order.js";
import {
  runWorkerLocalGate,
  readWorkspace,
  workspaceGlobs,
} from "./local-gate.js";

const roots: string[] = [];
const fixtureApp = "apps/plugin-dev";
const fixtureSource = `${fixtureApp}/src/index.ts`;
const fixtureAddedSource = `${fixtureApp}/added.ts`;
const fixtureBackpressureCommand = `pnpm -C ${fixtureApp} test:invariants`;

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worker-local-gate-"));
  roots.push(root);
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n  - packages/*\n",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "root", scripts: { test: "true" } }),
  );
  await mkdir(join(root, fixtureApp), { recursive: true });
  await writeFile(
    join(root, fixtureApp, "package.json"),
    JSON.stringify({
      name: "@fixture/dev",
      scripts: { typecheck: "true" },
      dependencies: { "@fixture/lib": "workspace:*" },
    }),
  );
  await mkdir(join(root, fixtureApp, "src"), { recursive: true });
  await writeFile(join(root, fixtureSource), "export const fixture = true;\n");
  await mkdir(join(root, "packages", "lib"), { recursive: true });
  await writeFile(
    join(root, "packages", "lib", "package.json"),
    JSON.stringify({ name: "@fixture/lib" }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "worker@example.invalid");
  git("config", "user.name", "Worker");
  git("add", "--all");
  git("commit", "-m", "Refs #4020");
  return root;
}

describe("reading the Worktree's package topology", () => {
  it("expands the workspace globs and keeps the workspace dependency edges", async () => {
    const root = await workspace();
    const { layout, graph } = readWorkspace(root);

    expect(layout.hasPackage(".")).toBe(true);
    expect(layout.hasPackage(fixtureApp)).toBe(true);
    expect(layout.hasPackage("apps/absent")).toBe(false);
    expect(layout.hasScript(fixtureApp, "typecheck")).toBe(true);
    expect(layout.hasScript(fixtureApp, "test")).toBe(false);
    expect(graph.packages.map((pkg) => pkg.dir).sort()).toEqual([
      ".",
      fixtureApp,
      "packages/lib",
    ]);
    expect(
      graph.packages.find((pkg) => pkg.dir === fixtureApp)?.dependsOn,
    ).toEqual(["packages/lib"]);
  });

  it("reads the packages list without a YAML decoder", () => {
    expect(
      workspaceGlobs(
        "packages:\n  - 'apps/*'\n  - packages/*  # comment\nonlyBuiltDependencies:\n  - esbuild\n",
      ),
    ).toEqual(["apps/*", "packages/*"]);
  });
});

describe("running the declared stages", () => {
  it("passes when the cone's scripts pass, and skips the stages nothing wired", async () => {
    const root = await workspace();
    const commands: string[][] = [];
    const result = await runWorkerLocalGate({
      worktree: root,
      base: "main",
      changedFiles: async () => [fixtureSource],
      feedbackExec: async (args) => {
        commands.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(gateVerdict(result.stages).ok).toBe(true);
    // The cone is the touched package plus nothing else it feeds.
    expect(commands.map((argv) => argv.join(" "))).toEqual([
      `pnpm -C ${join(root, fixtureApp)} typecheck`,
    ]);
    expect(
      result.stages.find((stage) => stage.stage === "backpressure")?.skipped,
    ).toBe(true);
    expect(
      result.stages.find((stage) => stage.stage === "review")?.skipped,
    ).toBe(true);
  });

  it("names the failing command in the detail a re-seed carries", async () => {
    const root = await workspace();
    const failingCommand = `pnpm -C ${join(root, fixtureApp)} typecheck`;
    const invokedCommands: string[] = [];
    const result = await runWorkerLocalGate({
      worktree: root,
      base: "main",
      changedFiles: async () => [fixtureSource],
      feedbackExec: async (args) => {
        invokedCommands.push(args.join(" "));
        return {
          code: 2,
          stdout: "",
          stderr: "TS2532: Object is possibly undefined",
        };
      },
    });

    const verdict = gateVerdict(result.stages);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStage).toBe("feedback");
    expect(invokedCommands).toEqual([failingCommand]);
    expect(
      result.checks.find((check) => check.status === "failed")?.record.command,
    ).toBe(failingCommand);
    expect(result.detail).toMatch(new RegExp(`^${escapeRegExp(failingCommand)}:`));
    expect(result.detail).toContain("typecheck");
    expect(result.detail).toContain("TS2532");
  });

  it("runs the operator's commands only after feedback passed", async () => {
    const root = await workspace();
    const ran: string[] = [];
    const blocked = await runWorkerLocalGate({
      worktree: root,
      base: "main",
      backpressureCommands: [fixtureBackpressureCommand],
      changedFiles: async () => [fixtureSource],
      feedbackExec: async () => ({ code: 1, stdout: "", stderr: "red" }),
      backpressureExec: async ({ command }) => {
        ran.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(gateVerdict(blocked.stages).failedStage).toBe("feedback");
    expect(ran).toEqual([]);

    const green = await runWorkerLocalGate({
      worktree: root,
      base: "main",
      backpressureCommands: [fixtureBackpressureCommand],
      changedFiles: async () => [fixtureSource],
      feedbackExec: async () => ({ code: 0, stdout: "", stderr: "" }),
      backpressureExec: async ({ command }) => {
        ran.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(gateVerdict(green.stages).ok).toBe(true);
    expect(ran).toEqual([fixtureBackpressureCommand]);
  });

  it("reads the real diff when the caller names no seam", async () => {
    const root = await workspace();
    await writeFile(
      join(root, fixtureAddedSource),
      "export const added = 1;\n",
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("checkout", "-b", "afk/4020");
    git("add", "--", fixtureAddedSource);
    git("commit", "-m", "Refs #4020");

    const commands: string[][] = [];
    await runWorkerLocalGate({
      worktree: root,
      base: "main",
      feedbackExec: async (args) => {
        commands.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(commands.map((argv) => argv.join(" "))).toEqual([
      `pnpm -C ${join(root, fixtureApp)} typecheck`,
    ]);
  }, 20_000);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
