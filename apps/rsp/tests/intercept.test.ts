import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import {
  RSP_WRAPPER_CAPABILITIES,
  formatCodexHookDecision,
  formatHookDecision,
  hookDecisionFromClaudePreExecJson,
  hookDecisionFromCodexPreExecJson,
  rewriteCommand,
  rewriteTableFromCapabilities,
  _testOnlyResetBinaryState,
} from "../src/intercept.js";

const RSP_PREFIX = ["rsp"] as const;
import {
  RSP_DECISIONS_COLLECTION,
  telemetrySpoolPath,
} from "../src/telemetry.js";

const roots: string[] = [];
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-intercept-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  _testOnlyResetBinaryState();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp interception pure rewrite table", () => {
  it("rewrites every wrapper capability form from the table", () => {
    for (const entry of RSP_WRAPPER_CAPABILITIES) {
      const decision = rewriteCommand(entry.command.join(" "), [...RSP_PREFIX]);
      expect(decision, entry.id).toEqual({
        kind: "rewrite",
        command: ["rsp", ...entry.wrapper].join(" "),
        capabilityId: entry.id,
      });
    }
  });

  it("rewrites every capability using the bundled entrypoint when rsp is not on PATH", () => {
    const prefix = ["/fake/node", "/fake/rsp.bundle.mjs"];
    for (const entry of RSP_WRAPPER_CAPABILITIES) {
      const decision = rewriteCommand(entry.command.join(" "), prefix);
      expect(decision, entry.id).toEqual({
        kind: "rewrite",
        command: ["/fake/node", "/fake/rsp.bundle.mjs", ...entry.wrapper].join(" "),
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
    ["cat-simple-file", "cat apps/rsp/src/cli.ts", "rsp cat apps/rsp/src/cli.ts", "cat:file"],
    ["cat-quoted-file", "cat 'two words.txt'", "rsp cat 'two words.txt'", "cat:file"],
    ["head-default-file", "head apps/rsp/src/cli.ts", "rsp cat --head 10 apps/rsp/src/cli.ts", "cat:head"],
    ["head-n-file", "head -n 25 apps/rsp/src/cli.ts", "rsp cat --head 25 apps/rsp/src/cli.ts", "cat:head"],
    ["head-short-n-file", "head -25 apps/rsp/src/cli.ts", "rsp cat --head 25 apps/rsp/src/cli.ts", "cat:head"],
    ["tail-default-file", "tail apps/rsp/src/cli.ts", "rsp cat --tail 10 apps/rsp/src/cli.ts", "cat:tail"],
    ["tail-n-file", "tail -n 25 apps/rsp/src/cli.ts", "rsp cat --tail 25 apps/rsp/src/cli.ts", "cat:tail"],
    ["tail-short-n-file", "tail -25 apps/rsp/src/cli.ts", "rsp cat --tail 25 apps/rsp/src/cli.ts", "cat:tail"],
  ])("rewrites conservative file dump shape %s", (_name, command, rewritten, capabilityId) => {
    expect(rewriteCommand(command, [...RSP_PREFIX])).toEqual({ kind: "rewrite", command: rewritten, capabilityId });
  });

  it.each([
    ["cat-bundled", "cat apps/rsp/src/cli.ts", "/fake/node /fake/rsp.bundle.mjs cat apps/rsp/src/cli.ts", "cat:file"],
    ["head-bundled", "head -n 5 apps/rsp/src/cli.ts", "/fake/node /fake/rsp.bundle.mjs cat --head 5 apps/rsp/src/cli.ts", "cat:head"],
  ])("rewrites file dump %s via bundled entrypoint", (_name, command, rewritten, capabilityId) => {
    expect(rewriteCommand(command, ["/fake/node", "/fake/rsp.bundle.mjs"])).toEqual({ kind: "rewrite", command: rewritten, capabilityId });
  });

  it.each([
    ["git-log-format-flags", "git log --oneline --decorate=short", "rsp git log --oneline --decorate=short", "git:log"],
    ["git-diff-stat-range", "git diff --stat origin/main..HEAD", "rsp git diff --stat origin/main..HEAD", "git:diff"],
    ["git-status-stderr-null", "git status --short 2>/dev/null", "rsp git status --short 2>/dev/null", "git:status"],
    ["git-log-stderr-merge", "git log --oneline 2>&1", "rsp git log --oneline 2>&1", "git:log"],
  ])("rewrites flagged or stderr-only family shape %s", (_name, command, rewritten, capabilityId) => {
    expect(rewriteCommand(command, [...RSP_PREFIX])).toEqual({ kind: "rewrite", command: rewritten, capabilityId });
  });

  // The gh json/jq selector shapes are classification cases and live in
  // tests/command-classifier.test.ts (#2659); the hook keeps its wired smoke
  // in "records gh json/jq selectors as lossless passthrough decisions" below.

  it.each([
    ["upstream-subcommand-identity-not-dropped", "git -C repo status"],
    ["upstream-space-arg-not-skipped-into-rewrite", "gh issue view \"two words\""],
    ["upstream-paren-arg-not-skipped-into-rewrite", "gh issue view 'needs (triage)'"],
    ["env-prefix-is-ambiguous", "GIT_DIR=.git git status"],
    ["silent-predicate-grep-q", "grep -q needle file"],
    ["redirection-is-ambiguous", "git status > status.txt"],
    ["stdout-redirection-is-ambiguous", "git status > status.txt"],
    ["stdin-redirection-is-ambiguous", "git status < input.txt"],
    ["stderr-file-redirection-is-ambiguous", "git status 2>err.txt"],
    ["cat-multiple-files-is-ambiguous", "cat a.txt b.txt"],
    ["head-option-shape-is-ambiguous", "head -c 20 file.txt"],
    ["subshell-is-ambiguous", "$(git status)"],
    ["quoted-command-name-is-ambiguous", "\"git\" status"],
  ])("passes through adversarial fixture %s", (_name, command) => {
    expect(rewriteCommand(command, [...RSP_PREFIX])).toEqual({ kind: "passthrough" });
  });

  it.each([
    ["chained-cd-git-log", "cd apps && git log --oneline"],
    ["piped-git-log-tail", "git log | tail -5"],
    ["semicolon-gh-list", "cd apps; gh pr list --limit 5"],
    ["piped-vitest", "vitest run | tail -20"],
    ["chained-cargo-test", "cd crates/core && cargo test"],
  ])("rewrites safe compound noisy command %s through rsp exec", (_name, command) => {
    expect(rewriteCommand(command, [...RSP_PREFIX])).toEqual({
      kind: "rewrite",
      command: `rsp exec -- '${command}'`,
      capabilityId: "exec:compound",
    });
  });

  it("rewrites compound noisy command through bundled exec entrypoint", () => {
    expect(rewriteCommand("cd apps && git log --oneline", ["/fake/node", "/fake/bundle.mjs"])).toEqual({
      kind: "rewrite",
      command: "/fake/node /fake/bundle.mjs exec -- 'cd apps && git log --oneline'",
      capabilityId: "exec:compound",
    });
  });

  it.each([
    ["interactive-editor", "vim ."],
    ["background-process", "sleep 10 &"],
    ["command-substitution-capture", "foo $(git log)"],
    ["already-rsp", "cd apps && rsp git log"],
    ["here-doc", "cat <<EOF"],
    ["silent-predicate", "git log | grep -q fix"],
  ])("passes through unsafe compound fixture %s", (_name, command) => {
    expect(rewriteCommand(command, [...RSP_PREFIX])).toEqual({ kind: "passthrough" });
  });
});

describe("rsp Claude pre-execution hook integration", () => {
  it("routes eligible commands through the universal proxy only when the proxy flag is enabled", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");

    const decision = await hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "printf ok | sed s/ok/OK/" } }),
      { cwd: root, wakeResident: () => undefined, rspInvocationPrefix: [...RSP_PREFIX] },
    );

    expect(decision).toEqual({
      kind: "rewrite",
      command: "rsp proxy -- 'printf ok | sed s/ok/OK/'",
      capabilityId: "proxy:universal",
    });
    expect(formatCodexHookDecision(decision)).toEqual({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "rsp proxy -- 'printf ok | sed s/ok/OK/'" },
        },
      })}\n`,
      status: 0,
    });
  });

  it("routes through bundled entrypoint proxy when rsp is not on PATH", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");

    const prefix = ["/fake/node", "/fake/rsp.bundle.mjs"];
    const decision = await hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "printf ok | sed s/ok/OK/" } }),
      { cwd: root, wakeResident: () => undefined, rspInvocationPrefix: prefix },
    );

    expect(decision).toEqual({
      kind: "rewrite",
      command: "/fake/node /fake/rsp.bundle.mjs proxy -- 'printf ok | sed s/ok/OK/'",
      capabilityId: "proxy:universal",
    });
  });

  it.each([
    ["interactive", "vim file.txt", "interactive"],
    ["background", "sleep 1 &", "background"],
    ["opt-out-env", "RSP_NO_PROXY=1 git status", "opt-out"],
    ["recursive-rsp", "rsp git status", "opt-out"],
  ])("leaves %s commands unproxied under the universal proxy flag", async (_label, command, reason) => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");

    await expect(hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command } }),
      { cwd: root, rspInvocationPrefix: [...RSP_PREFIX] },
    )).resolves.toEqual({ kind: "passthrough", reason });
  });

  it("opts out of re-proxying a bundled rsp invocation", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");

    // A command that IS the bundled invocation must not be proxied again
    const bundledCommand = `${process.execPath} ${process.argv[1]} git status`;
    await expect(hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: bundledCommand } }),
      { cwd: root, rspInvocationPrefix: [process.execPath, process.argv[1]!] },
    )).resolves.toEqual({ kind: "passthrough", reason: "opt-out" });
  });

  it("accepts Claude hook JSON on stdin through the CLI and emits updatedInput", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify({ cwd: root, tool_input: { command: "git status" } })),
    });

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: expect.stringContaining("git status") },
      },
    });
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports rewrite and parse decisions under RSP_DEBUG", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: false\n", "utf8");

    const rewrite = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-pre-exec"], {
      cwd: root,
      env: { ...process.env, RSP_DEBUG: "1" },
      input: Buffer.from(JSON.stringify({ cwd: root, tool_input: { command: "git status" } })),
    });

    expect(rewrite.status).toBe(0);
    expect(rewrite.stderr.toString("utf8")).toContain("rsp hook claude-pre-exec: rewrite git:status\n");

    const parseFailure = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-pre-exec"], {
      cwd: root,
      env: { ...process.env, RSP_DEBUG: "1" },
      input: Buffer.from("{"),
    });

    expect(parseFailure.status).toBe(0);
    expect(parseFailure.stdout).toEqual(Buffer.alloc(0));
    expect(parseFailure.stderr.toString("utf8")).toContain("rsp hook claude-pre-exec: passthrough payload-parse-error\n");
  });

  it("prints Claude updatedInput JSON and exits 0 on a certain match", async () => {
    const root = await tempRoot();
    let healthCalls = 0;
    let wakeCalls = 0;
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
      {
        cwd: root,
        isEnabled: () => true,
        isResidentHealthy: async () => {
          healthCalls += 1;
          return true;
        },
        wakeResident: () => {
          wakeCalls += 1;
        },
        rspInvocationPrefix: [...RSP_PREFIX],
      },
    );

    expect(formatHookDecision(result)).toEqual({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "rsp git status" },
        },
      }) + "\n",
      status: 0,
    });
    expect(healthCalls).toBe(0);
    expect(wakeCalls).toBe(1);
  });

  it("prints a shell-safe rsp exec updatedInput for compound noisy commands", async () => {
    const root = await tempRoot();
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "cd apps && git log --oneline" } }),
      {
        cwd: root,
        isEnabled: () => true,
        isResidentHealthy: async () => true,
        rspInvocationPrefix: [...RSP_PREFIX],
      },
    );

    expect(formatHookDecision(result)).toEqual({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "rsp exec -- 'cd apps && git log --oneline'" },
        },
      }) + "\n",
      status: 0,
    });
  });

  it("prints updatedInput for flagged family forms", async () => {
    const root = await tempRoot();
    let healthCalls = 0;
    let wakeCalls = 0;
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status --short" } }),
      {
        cwd: root,
        isEnabled: () => true,
        isResidentHealthy: async () => {
          healthCalls += 1;
          return true;
        },
        wakeResident: () => {
          wakeCalls += 1;
        },
        rspInvocationPrefix: [...RSP_PREFIX],
      },
    );

    expect(formatHookDecision(result)).toEqual({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "rsp git status --short" },
        },
      }) + "\n",
      status: 0,
    });
    expect(healthCalls).toBe(0);
    expect(wakeCalls).toBe(1);
  });

  it("rewrites and wakes the resident without health-gating the decision", async () => {
    const root = await tempRoot();
    let healthCalls = 0;
    let wakeCalls = 0;
    const started = performance.now();
    const result = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
      {
        cwd: root,
        isEnabled: () => true,
        isResidentHealthy: async () => {
          healthCalls += 1;
          return false;
        },
        wakeResident: () => {
          wakeCalls += 1;
        },
        rspInvocationPrefix: [...RSP_PREFIX],
      },
    );
    const elapsedMs = performance.now() - started;

    expect(result).toEqual({ kind: "rewrite", command: "rsp git status", capabilityId: "git:status" });
    expect(formatHookDecision(result).status).toBe(0);
    expect(healthCalls).toBe(0);
    expect(wakeCalls).toBe(1);
    expect(elapsedMs).toBeLessThan(50);
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
    expect(formatHookDecision(result)).toEqual({ stdout: "", status: 0 });
  });
});

describe("rsp Codex pre-execution hook integration", () => {
  it("prints a Codex PreToolUse updatedInput response on a certain match when the resident is healthy", async () => {
    const root = await tempRoot();
    const result = await hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "git status" } }),
      {
        cwd: root,
        isEnabled: () => true,
        isResidentHealthy: async () => true,
        rspInvocationPrefix: [...RSP_PREFIX],
      },
    );

    expect(formatCodexHookDecision(result)).toEqual({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "rsp git status" },
        },
      }) + "\n",
      status: 0,
    });
  });

  it("keeps disabled directories inert and exits 0 for Codex fail-open semantics", async () => {
    const root = await tempRoot();
    let rewriteCalls = 0;
    const result = await hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
      {
        cwd: root,
        isEnabled: () => false,
        rewrite: () => {
          rewriteCalls += 1;
          return { kind: "rewrite", command: "rsp git status", capabilityId: "unexpected" };
        },
      },
    );

    expect(result).toEqual({ kind: "passthrough", reason: "disabled" });
    expect(rewriteCalls).toBe(0);
    expect(formatCodexHookDecision(result)).toEqual({ stdout: "", status: 0 });
  });

  it("accepts Codex hook JSON on stdin through the CLI", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "codex-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "git status" } })),
    });

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: expect.stringContaining("git status") },
      },
    });
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records exactly one decision event for a Codex hook invocation", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: false\n", "utf8");

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "codex-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "git status" } })),
    });

    expect(res.status).toBe(0);
    const events = await readSpoolEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      collection: RSP_DECISIONS_COLLECTION,
      hook: "codex-pre-exec",
      command: "git status",
      command_family: "git status",
      decision: "contributed",
      reason: "matched-capability",
      capability_id: "git:status",
    });
  });

  it("records gh json/jq selectors as lossless passthrough decisions", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: false\n", "utf8");

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "codex-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "gh pr view 1747 --json number,title --jq .number" } })),
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(Buffer.alloc(0));
    const events = await readSpoolEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      collection: RSP_DECISIONS_COLLECTION,
      hook: "codex-pre-exec",
      command: "gh pr view 1747 --json number,title --jq .number",
      command_family: "gh pr view json-jq",
      decision: "passed",
      reason: "lossless-gh-json-jq",
    });
  });

  it("records quarter-plus coverage when replaying representative agent command corpus", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    const corpus = [
      "git log --oneline --decorate=short",
      "git diff --stat origin/main..HEAD",
      "gh pr view 1746 --json number,title",
      "cat 'two words.txt'",
      "echo ok",
      "git status > status.txt",
      "grep -q needle file.txt",
      "sleep 1 &",
    ];

    for (const command of corpus) {
      const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "codex-pre-exec"], {
        cwd: root,
        input: Buffer.from(JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command } })),
      });
      expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
    }

    const events = await readSpoolEvents(root) as Array<{ decision: string }>;
    const contributed = events.filter((event) => event.decision === "contributed").length;
    expect(events).toHaveLength(corpus.length);
    expect(contributed / events.length).toBeGreaterThanOrEqual(0.25);
  });
});

describe("rsp binary resolution guard", () => {
  it("passes through with binary-unresolved when entrypoint is unresolvable", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
      { cwd: root, isEnabled: () => true, resolveBinary: () => false },
    );
    expect(decision).toEqual({ kind: "passthrough", reason: "binary-unresolved" });
  });

  it("raw command is untouched on unresolvable entrypoint (empty updatedInput)", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePreExecJson(
      JSON.stringify({ cwd: root, tool_input: { command: "git log --oneline" } }),
      { cwd: root, isEnabled: () => true, resolveBinary: () => false },
    );
    expect(formatHookDecision(decision)).toEqual({ stdout: "", status: 0 });
  });

  it("caches the resolution result; resolver called once across multiple invocations", async () => {
    const root = await tempRoot();
    let callCount = 0;
    const opts = {
      cwd: root,
      isEnabled: () => true as boolean,
      resolveBinary: () => { callCount += 1; return false; },
    };

    for (let i = 0; i < 3; i++) {
      await hookDecisionFromClaudePreExecJson(
        JSON.stringify({ cwd: root, tool_input: { command: "git status" } }),
        opts,
      );
    }

    expect(callCount).toBe(1);
  });

  it("passes through with binary-unresolved in the proxy path too", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");

    const decision = await hookDecisionFromCodexPreExecJson(
      JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "printf ok" } }),
      { cwd: root, resolveBinary: () => false },
    );
    expect(decision).toEqual({ kind: "passthrough", reason: "binary-unresolved" });
  });

  it("uses the self-entry fallback and records contribution when rsp is absent from PATH", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "codex-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify({ cwd: root, tool_name: "bash", tool_input: { command: "git status" } })),
      env: { ...process.env, PATH: "/no-rsp-here" },
    });

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        updatedInput: { command: `${process.execPath} ${cli} proxy -- 'git status'` },
      },
    });
    const events = await readSpoolEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      collection: RSP_DECISIONS_COLLECTION,
      decision: "contributed",
      reason: "universal-proxy",
    });
  });
});

async function readSpoolEvents(root: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(telemetrySpoolPath(root), "utf8").catch(() => "");
  const rows: Array<Record<string, unknown>> = [];
  let header = "";
  for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (/^\[(?:\d*)\]\{[^}]+\}:$/.test(line)) {
      header = line;
      continue;
    }
    if (!header) continue;
    for (const row of parseRecords(`${header}\n${line}\n`)) {
      if (!isRecord(row)) continue;
      if (typeof row.event_json !== "string") {
        const { spool_id: _spoolId, ...event } = row;
        if (typeof event.collection === "string") rows.push(event);
        continue;
      }
      const event = JSON.parse(row.event_json) as unknown;
      if (isRecord(event)) rows.push(event);
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
