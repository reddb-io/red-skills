import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  RSP_WRAPPER_CAPABILITIES,
  formatHookDecision,
  hookDecisionFromClaudePreExecJson,
  rewriteCommand,
  rewriteTableFromCapabilities,
} from "../src/intercept.js";

const roots: string[] = [];
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-intercept-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp interception pure rewrite table", () => {
  it("rewrites every wrapper capability form from the table", () => {
    for (const entry of RSP_WRAPPER_CAPABILITIES) {
      const decision = rewriteCommand(entry.command.join(" "));
      expect(decision, entry.id).toEqual({
        kind: "rewrite",
        command: ["rsp", ...entry.wrapper].join(" "),
        capabilityId: entry.id,
      });
    }
  });

  it("keeps the rewrite allowlist derived from the capability table", () => {
    const extended = [
      ...RSP_WRAPPER_CAPABILITIES,
      { id: "fixture:echo", command: ["echo", "ok"], wrapper: ["fixture", "echo"] },
    ];

    expect(rewriteTableFromCapabilities(extended).get("echo\0ok")).toEqual(["rsp", "fixture", "echo"]);
  });

  it.each([
    ["upstream-subcommand-identity-not-dropped", "git -C repo status"],
    ["upstream-space-arg-not-skipped-into-rewrite", "gh issue view \"two words\""],
    ["upstream-paren-arg-not-skipped-into-rewrite", "gh issue view 'needs (triage)'"],
    ["env-prefix-is-ambiguous", "GIT_DIR=.git git status"],
    ["silent-predicate-grep-q", "grep -q needle file"],
    ["redirection-is-ambiguous", "git status > status.txt"],
    ["subshell-is-ambiguous", "$(git status)"],
    ["compound-command-is-ambiguous", "git status && echo done"],
    ["quoted-command-name-is-ambiguous", "\"git\" status"],
  ])("passes through adversarial fixture %s", (_name, command) => {
    expect(rewriteCommand(command)).toEqual({ kind: "passthrough" });
  });
});

describe("rsp Claude pre-execution hook integration", () => {
  it("accepts Claude hook JSON on stdin through the CLI and returns the stdout/exit contract", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify({ cwd: root, tool_input: { command: "git status" } })),
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(Buffer.from("rsp git status\n"));
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("prints only the rewritten command and exits 0 on a certain match", async () => {
    const root = await tempRoot();
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
      { cwd: root, isEnabled: () => true },
    );

    expect(formatHookDecision(result)).toEqual({ stdout: "rsp git status\n", status: 0 });
  });

  it("prints nothing and exits non-zero on passthrough", async () => {
    const root = await tempRoot();
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status --short" } }),
      { cwd: root, isEnabled: () => true },
    );

    expect(formatHookDecision(result)).toEqual({ stdout: "", status: 1 });
  });

  it("makes disabled directories inert before rewrite work", async () => {
    const root = await tempRoot();
    let gateCalls = 0;
    let rewriteCalls = 0;
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
      {
        cwd: root,
        isEnabled: () => {
          gateCalls += 1;
          return false;
        },
        rewrite: () => {
          rewriteCalls += 1;
          return { kind: "rewrite", command: "rsp git status", capabilityId: "unexpected" };
        },
      },
    );

    expect(result).toEqual({ kind: "passthrough", reason: "disabled" });
    expect(gateCalls).toBe(1);
    expect(rewriteCalls).toBe(0);
    expect(formatHookDecision(result)).toEqual({ stdout: "", status: 1 });
  });
});
