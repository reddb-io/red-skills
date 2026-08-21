import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declaredChildAgentEndpoint } from "../src/acp-agent-catalog.js";
import { childAgentWorkspaceEnv, codexAgentHome, ensureChildAgentHome } from "../src/acp-agent-home.js";
import { nativeWorkerSpec, runnerFromSessionMeta } from "../src/acp-worker-admission.js";
import { demandAdmissionSessionRequest, demandTurnForBirth, runnerFromLaunchArgv } from "../src/acp-demand-turn.js";
import type { AcpProjectWorkspace } from "../src/project-workspace.js";
import type { MaterializedWorkerWorkspace } from "../src/worker-workspace.js";

// The drain registered `--child-agent codex` and every Worker was still born
// redcode: admission composed its child from a hardcoded default and never read
// the registration. This suite pins the whole declared-runner route — argv →
// demand turn → session meta → admission — so a registered runner is the one a
// Worker actually runs, and an unknown one is refused by name.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const project: AcpProjectWorkspace = {
  projectId: "remote:reddb-io/red-skills",
  projectLabel: "reddb-io/red-skills",
  checkoutRoot: "/tmp/checkout",
  workspacePath: "/tmp/project-workspace",
};
const workspace: MaterializedWorkerWorkspace = {
  workerId: "VStest03",
  root: "/tmp/workers",
  workspacePath: "/tmp/workers/VStest03",
  worktreePath: "/tmp/workers/VStest03/worktree",
} as MaterializedWorkerWorkspace;

describe("the registered runner reaches the born Worker", () => {
  it("reads the runner from a registration's launch argv, and an unknown name is no declaration", () => {
    expect(runnerFromLaunchArgv(["npx", "-y", "acp-worker", "--child-agent", "codex"])).toBe("codex");
    expect(runnerFromLaunchArgv(["acp-worker", "--child-agent", "redcode"])).toBe("redcode");
    expect(runnerFromLaunchArgv(["acp-worker", "--child-agent", "gpt-magic"])).toBeNull();
    expect(runnerFromLaunchArgv(["acp-worker", "--child-agent"])).toBeNull();
    expect(runnerFromLaunchArgv(["acp-worker"])).toBeNull();
    expect(runnerFromLaunchArgv(undefined)).toBeNull();
  });

  it("carries the declared runner on the demand turn it briefs", () => {
    const turn = demandTurnForBirth(
      {
        prompt: "Work issue #{{work_item}}",
        trunk: { branch: "main" },
        argv: ["npx", "acp-worker", "--child-agent", "codex"],
      },
      { workspace_path: "/tmp/w", index: 0, work_item: "4153" },
      "VStest04",
      { id: "4153", title: "a ticket", labels: [] },
    );
    expect(turn?.runner).toBe("codex");
  });

  it("restates the declared runner on the synthetic session request admission actually reads", () => {
    const briefed = demandAdmissionSessionRequest({ project, runner: "codex" });
    expect(runnerFromSessionMeta(briefed._meta)).toBe("codex");
    expect(briefed.cwd).toBe(project.workspacePath);
    const unbriefed = demandAdmissionSessionRequest({ project });
    expect(unbriefed._meta).toBeUndefined();
    expect(runnerFromSessionMeta(unbriefed._meta)).toBeNull();
  });

  it("accepts only catalog runner ids from session meta", () => {
    expect(runnerFromSessionMeta({ redskills: { runner: "codex" } })).toBe("codex");
    expect(runnerFromSessionMeta({ redskills: { runner: "opencode" } })).toBe("opencode");
    expect(runnerFromSessionMeta({ redskills: { runner: "sh -c rm" } })).toBeNull();
    expect(runnerFromSessionMeta({ redskills: {} })).toBeNull();
    expect(runnerFromSessionMeta(undefined)).toBeNull();
  });

  it("admits a codex Worker through the npx-pinned adapter, never through a bare guess", () => {
    const endpoint = declaredChildAgentEndpoint("codex");
    expect(endpoint.agent).toBe("codex");
    expect(endpoint.command).toBe("npx");
    expect(endpoint.args).toEqual(["-y", "-p", "@zed-industries/codex-acp@0.16.0", "codex-acp"]);
  });

  it("still admits the governed native default exactly as before", () => {
    const endpoint = declaredChildAgentEndpoint("redcode");
    expect([endpoint.command, ...endpoint.args]).toEqual(["redcode", "acp"]);
  });

  it("hands the runner through nativeWorkerSpec argv and keeps redcode's workspace DB", () => {
    const codexSpec = nativeWorkerSpec(project, workspace, "/tmp/sock/x.sock", "/tmp/runtime", "afk", "codex");
    const codexArgs = codexSpec.args ?? [];
    expect(codexArgs[codexArgs.indexOf("--child-agent") + 1]).toBe("codex");
    expect(codexSpec.env?.OPENCODE_DB).toBeUndefined();
    expect(codexSpec.env?.CODEX_HOME).toBe(codexAgentHome());

    const redcodeSpec = nativeWorkerSpec(project, workspace, "/tmp/sock/x.sock", "/tmp/runtime", "afk");
    const redcodeArgs = redcodeSpec.args ?? [];
    expect(redcodeArgs[redcodeArgs.indexOf("--child-agent") + 1]).toBe("redcode");
    expect(redcodeSpec.env?.OPENCODE_DB).toBe(join(workspace.workspacePath, "redcode.db"));
  });
});

describe("the daemon-owned codex home", () => {
  it("is refused loudly when the operator never logged in", async () => {
    const home = await mkdtemp(join(tmpdir(), "redskilled-agent-home-"));
    roots.push(home);
    await expect(ensureChildAgentHome("codex", home)).rejects.toThrow(/codex login/);
  });

  it("seeds the operator credential once, re-seeds on re-login, and keeps the child's own refresh", async () => {
    const home = await mkdtemp(join(tmpdir(), "redskilled-agent-home-"));
    roots.push(home);
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), '{"t":"operator-1"}');

    await ensureChildAgentHome("codex", home);
    const seeded = join(codexAgentHome(home), "auth.json");
    expect(await readFile(seeded, "utf8")).toBe('{"t":"operator-1"}');
    expect(((await stat(seeded)).mode & 0o777)).toBe(0o600);
    expect(childAgentWorkspaceEnv("codex", "/tmp/w", home).CODEX_HOME).toBe(codexAgentHome(home));

    // The child refreshed its own token: a NEWER seed is never clobbered by an older login.
    await writeFile(seeded, '{"t":"child-refreshed"}');
    const past = new Date(Date.now() - 60_000);
    await utimes(join(home, ".codex", "auth.json"), past, past);
    await ensureChildAgentHome("codex", home);
    expect(await readFile(seeded, "utf8")).toBe('{"t":"child-refreshed"}');

    // The operator re-logged in afterwards: the newer login reaches Workers.
    await writeFile(join(home, ".codex", "auth.json"), '{"t":"operator-2"}');
    await ensureChildAgentHome("codex", home);
    expect(await readFile(seeded, "utf8")).toBe('{"t":"operator-2"}');
  });

  it("does nothing for agents that keep no daemon-owned home", async () => {
    const home = await mkdtemp(join(tmpdir(), "redskilled-agent-home-"));
    roots.push(home);
    await ensureChildAgentHome("redcode", home);
    expect(childAgentWorkspaceEnv("opencode", "/tmp/w", home)).toEqual({});
  });
});
