// A Worker's bytes live in OS temporary storage, never in the human's checkout
// (issue #4017, ADR 0149 §1, ADR 0150 §2).
//
// The three facts this pins are the three the old layout got wrong. A Worker
// materialised inside the client checkout's `.red/tmp`, so a human's directory
// grew to 3.1 GB and a janitor had to guess which entries were its own; nothing
// told the process which Working mode it was running in; and a dead Worker's
// workspace outlived it because deleting it meant trusting a path assembled
// from two halves. So the assertions are made against a REAL process: the
// Worker is born, it reports where it stands and what mode it was told it is
// in, it dies, and the checkout is inspected before and after.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { launchWorker, mintHostWorkerId } from "../src/worker-launch.js";
import {
  anonymousFetchUrl,
  materializeWorkerWorkspace,
  releaseWorkerWorkspace,
  workerWorkspaceDir,
  workerWorkspaceRoot,
  workerWorktreePath,
  WorkerWorkspaceError,
} from "../src/worker-workspace.js";
import { workerModeEnv } from "@reddb-io/shared/working-mode.js";

const roots: string[] = [];

/**
 * #4188: the Project mirror is cloned once and never fetched again, so without
 * a refresh every Worker forks a days-old tree and the gate judges code main
 * no longer has. The trunk refresh runs against the CANONICAL remote, before
 * the clone, and a failed fetch degrades to a stale fork instead of a refusal.
 */
describe("the fork refreshes the mirror's trunk first", () => {
  const recordedGit = (answers: (args: readonly string[]) => string | undefined) => {
    const calls: string[][] = [];
    const git = async (_cwd: string, args: readonly string[]) => {
      calls.push([...args]);
      return answers(args);
    };
    return { calls, git };
  };

  it("fetches the canonical trunk and advances the mirror before cloning", async () => {
    const { calls, git } = recordedGit((args) =>
      args[0] === "rev-parse" ? "true" : args[0] === "symbolic-ref" ? "main" : "");

    await materializeWorkerWorkspace({
      root: await scratch("redskilled-fresh-fork-"),
      workerId: "VSfresh1",
      projectWorkspacePath: "/tmp/mirror",
      git,
      trunk: { remoteUrl: "https://github.com/o/r.git" },
    });

    const verbs = calls.map((args) => args[0]);
    expect(calls).toContainEqual(["fetch", "--quiet", "https://github.com/o/r.git", "main"]);
    expect(calls).toContainEqual(["reset", "--hard", "FETCH_HEAD"]);
    expect(verbs.indexOf("fetch")).toBeLessThan(verbs.indexOf("clone"));
  });

  it("forks stale rather than refusing when the fetch fails", async () => {
    const { calls, git } = recordedGit((args) =>
      args[0] === "rev-parse" ? "true" : args[0] === "fetch" ? undefined : args[0] === "symbolic-ref" ? "main" : "");

    await materializeWorkerWorkspace({
      root: await scratch("redskilled-fresh-fork-"),
      workerId: "VSfresh2",
      projectWorkspacePath: "/tmp/mirror",
      git,
      trunk: { remoteUrl: "https://github.com/o/r.git" },
    });

    const verbs = calls.map((args) => args[0]);
    expect(verbs).not.toContain("reset");
    expect(verbs).toContain("clone");
  });

  it("rewrites a GitHub SSH remote to anonymous HTTPS for the fetch", async () => {
    const { calls, git } = recordedGit((args) =>
      args[0] === "rev-parse" ? "true" : args[0] === "symbolic-ref" ? "main" : "");

    await materializeWorkerWorkspace({
      root: await scratch("redskilled-fresh-fork-"),
      workerId: "VSfresh4",
      projectWorkspacePath: "/tmp/mirror",
      git,
      trunk: { remoteUrl: "git@github.com:reddb-io/red-skills.git" },
    });

    // The daemon has no ssh-agent; an SSH fetch fails silently and every fork
    // stays days stale — the rewrite is what makes the refresh actually run.
    expect(calls).toContainEqual(["fetch", "--quiet", "https://github.com/reddb-io/red-skills.git", "main"]);
  });

  it("passes non-GitHub and HTTPS URLs through untouched", () => {
    expect(anonymousFetchUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(anonymousFetchUrl("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(anonymousFetchUrl("git@gitlab.example:o/r.git")).toBe("git@gitlab.example:o/r.git");
  });

  it("touches nothing without a declared trunk", async () => {
    const { calls, git } = recordedGit((args) => (args[0] === "rev-parse" ? "true" : ""));

    await materializeWorkerWorkspace({
      root: await scratch("redskilled-fresh-fork-"),
      workerId: "VSfresh3",
      projectWorkspacePath: "/tmp/mirror",
      git,
    });

    expect(calls.map((args) => args[0])).not.toContain("fetch");
  });
});



afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A client checkout with an empty `.red/tmp`: the lane nothing may write into. */
async function clientCheckout(): Promise<string> {
  const checkout = await scratch("redskilled-client-checkout-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "daemon@example.invalid");
  git("config", "user.name", "redskilled");
  await mkdir(join(checkout, ".red", "tmp"), { recursive: true });
  await writeFile(join(checkout, "tracked.txt"), "committed in the Project workspace\n");
  git("add", "--", "tracked.txt");
  git("commit", "-m", "Refs #4017");
  return checkout;
}

describe("the host root a Worker workspace hangs off", () => {
  it("is the OS temporary directory, segmented by the owning user", () => {
    expect(workerWorkspaceRoot({ tmpDir: "/var/tmp", uid: 1000 })).toBe("/var/tmp/red-skills-1000/workers");
    expect(workerWorkspaceRoot({ tmpDir: "/var/tmp", uid: "Ada Lovelace" })).toBe(
      "/var/tmp/red-skills-ada-lovelace/workers",
    );
  });

  it("names a Worker by its id alone, with the worktree as the direct child", () => {
    const root = workerWorkspaceRoot({ tmpDir: "/var/tmp", uid: 1000 });
    expect(workerWorkspaceDir(root, "0aBcDeF")).toBe("/var/tmp/red-skills-1000/workers/0aBcDeF");
    expect(workerWorktreePath(root, "0aBcDeF")).toBe("/var/tmp/red-skills-1000/workers/0aBcDeF/worktree");
  });

  it("refuses an id that would escape the root rather than resolving it", () => {
    const root = workerWorkspaceRoot({ tmpDir: "/var/tmp", uid: 1000 });
    expect(() => workerWorkspaceDir(root, "../elsewhere")).toThrow(WorkerWorkspaceError);
    expect(() => workerWorkspaceDir(root, "  ")).toThrow(WorkerWorkspaceError);
  });
});

describe("a real-process Worker born under the OS temp root", () => {
  it("stands in its own worktree with RED_MODE set, and leaves the checkout untouched", async () => {
    const checkout = await clientCheckout();
    const tmpDir = await scratch("redskilled-tmp-root-");
    const root = workerWorkspaceRoot({ tmpDir, uid: 4017 });
    const workerId = mintHostWorkerId([]);

    const workspace = await materializeWorkerWorkspace({
      root,
      workerId,
      projectWorkspacePath: checkout,
    });
    expect(workspace.worktreePath).toBe(join(root, workerId, "worktree"));
    expect(workspace.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    // The fork carries the Project workspace's committed state, and only that.
    expect(existsSync(join(workspace.worktreePath, "tracked.txt"))).toBe(true);

    const report = join(workspace.workspacePath, "report.toonl");
    const launched = launchWorker({
      spec: {
        worker_id: workerId,
        project_label: "github:4017",
        workspace_path: workspace.worktreePath,
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], `${process.cwd()}\\n${process.env.RED_MODE}\\n`)",
          report,
        ],
        env: workerModeEnv("afk"),
      },
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
    });
    expect(launched.worker.worker_id).toBe(workerId);
    await new Promise<void>((resolve) => launched.child.once("exit", () => resolve()));

    const [cwd, mode] = (await readFile(report, "utf8")).trim().split("\n");
    expect(cwd).toBe(workspace.worktreePath);
    expect(mode).toBe("spec-driven");
    // ADR 0149 §4: nothing a Worker does reaches the human's lane.
    expect(readdirSync(join(checkout, ".red", "tmp"))).toEqual([]);

    await releaseWorkerWorkspace(workspace);
    expect(existsSync(workspace.workspacePath)).toBe(false);
    expect(readdirSync(join(checkout, ".red", "tmp"))).toEqual([]);
  });

  it("carries the ad-hoc marker for a /go dispatch", async () => {
    const checkout = await clientCheckout();
    const tmpDir = await scratch("redskilled-tmp-root-");
    const root = workerWorkspaceRoot({ tmpDir, uid: 4017 });
    const workspace = await materializeWorkerWorkspace({
      root,
      workerId: mintHostWorkerId([]),
      projectWorkspacePath: checkout,
    });

    const report = join(workspace.workspacePath, "mode.txt");
    const launched = launchWorker({
      spec: {
        worker_id: workspace.workerId,
        project_label: "github:4017",
        workspace_path: workspace.worktreePath,
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], process.env.RED_MODE ?? '')", report],
        env: workerModeEnv("go"),
      },
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
    });
    await new Promise<void>((resolve) => launched.child.once("exit", () => resolve()));

    expect(await readFile(report, "utf8")).toBe("ad-hoc");
  });
});

describe("releasing a dead Worker's workspace", () => {
  it("is idempotent, because temporary storage may have reclaimed it first", async () => {
    const tmpDir = await scratch("redskilled-tmp-root-");
    const root = workerWorkspaceRoot({ tmpDir, uid: 4017 });
    const workspace = await materializeWorkerWorkspace({
      root,
      workerId: "0aBcDeF",
      projectWorkspacePath: await scratch("redskilled-not-a-repo-"),
    });
    expect(existsSync(workspace.worktreePath)).toBe(true);

    await releaseWorkerWorkspace(workspace);
    await releaseWorkerWorkspace(workspace);
    expect(existsSync(workspace.workspacePath)).toBe(false);
  });

  it("refuses a path the Worker does not own under its host root", async () => {
    const tmpDir = await scratch("redskilled-tmp-root-");
    const root = workerWorkspaceRoot({ tmpDir, uid: 4017 });
    const elsewhere = await scratch("redskilled-someone-elses-");
    await expect(releaseWorkerWorkspace({
      workerId: "0aBcDeF",
      root,
      workspacePath: elsewhere,
      worktreePath: join(elsewhere, "worktree"),
    })).rejects.toThrow(WorkerWorkspaceError);
    expect(existsSync(elsewhere)).toBe(true);
  });
});
