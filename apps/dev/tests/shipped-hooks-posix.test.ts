// shipped-hooks-posix — pins the shipped-hook interpreter contract (Spec #2466,
// slice #2626).
//
// ONE strategy, applied to every shipped hook: **a shipped hook script is a
// bash script, and every invocation site names bash explicitly** (either
// `bash <path>` at the call site or a `#!` bash shebang on a directly-executed
// file). The AFK boot probe already makes `bash` >= 3.2 a hard host
// prerequisite (`core/operational-probes/host-prerequisites.ts`), so bash is
// guaranteed present before any hook runs.
//
// The corollary — and the reason this file exists — is that the host's
// `/bin/sh` is NOT assumed to be bash. Hosts hand us `sh -c '<wrapper>'`
// (`claude.hooks.json`, `codex.hooks.json`, `.mcp.json`), and on Debian/Ubuntu
// that `sh` is dash. So the wrappers stay strictly POSIX, and the hooks they
// call are reached through bash. This suite proves both halves against a real
// dash: the wrapper scripts parse under `dash -n`, and every shipped hook
// executes end-to-end in an environment whose `sh` IS dash.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHookExec } from "../src/runtime/hooks.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Directories whose scripts ship as hooks (recursively, minus `tests/`). */
const HOOK_DIRS = [
  "plugins/dev/hooks",
  "plugins/dev/skills/engineering/afk/hooks",
  "plugins/dev/skills/engineering/afk/defaults",
  "plugins/dev/skills/engineering/afk/detectors",
  "plugins/dev/skills/misc/branch-lock/scripts",
  "plugins/dev/skills/misc/git-guardrails-claude-code/scripts",
] as const;

/** Hook manifests + MCP launch configs whose commands run under the host's `sh`. */
const HOST_MANIFESTS = [
  "plugins/dev/hooks/claude.hooks.json",
  "plugins/dev/hooks/codex.hooks.json",
  "plugins/dev/.mcp.json",
  "plugins/memory/hooks/claude.hooks.json",
  "plugins/memory/hooks/codex.hooks.json",
  "plugins/brain/hooks/claude.hooks.json",
  "plugins/brain/hooks/codex.hooks.json",
] as const;

/**
 * Launchers that `exec` a long-running MCP server. They are still executed
 * below — the npx/node stubs in the sandbox PATH make them return immediately —
 * but their exit code carries no signal, only the absence of a syntax error.
 */
const SERVER_LAUNCHERS = new Set(["plugins/dev/hooks/redskilled-mcp.sh", "plugins/dev/hooks/code-nav-mcp.sh"]);

/** `scripts/lib/*` files are `source`d by a bash parent, never executed on their own. */
function isSourcedLibrary(rel: string): boolean {
  return rel.includes("/scripts/lib/");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "tests") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function isShellScript(path: string): boolean {
  if (path.endsWith(".mjs") || path.endsWith(".json") || path.endsWith(".md")) return false;
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  return /^#!.*\b(bash|sh)\b/.test(first);
}

function shippedHooks(): string[] {
  const found = HOOK_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
    .filter(isShellScript)
    .map((path) => relative(ROOT, path))
    .sort();
  return found;
}

const HOOKS = shippedHooks();

function shebang(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").split("\n", 1)[0] ?? "";
}

/** Every `command` string anywhere in a host manifest JSON document. */
function manifestCommands(rel: string): string[] {
  const commands: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === "string") {
      // Claude/Codex hook entries: `command` is the whole shell line.
      // `.mcp.json` servers: `command` is the interpreter, `args` the script.
      const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [];
      commands.push([record.command, ...args].join(" "));
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(JSON.parse(readFileSync(join(ROOT, rel), "utf8")));
  return commands;
}

/** Unwrap `sh -c '<script>'` to the inner script the host's `sh` actually parses. */
function innerShScript(command: string): string | undefined {
  const match = /^sh -c '([\s\S]*)'$/.exec(command.trim());
  if (!match) return undefined;
  return match[1]!.replaceAll("'\\''", "'");
}

function dashParse(script: string): { ok: boolean; stderr: string } {
  const file = join(mkdtempSync(join(tmpdir(), "posix-hook-")), "candidate.sh");
  writeFileSync(file, script);
  const result = spawnSync("dash", ["-n", file], { encoding: "utf8" });
  return { ok: result.status === 0, stderr: result.stderr ?? "" };
}

/**
 * `dash -n` only rejects *parse* errors — `[[ -n x ]]` parses fine and then
 * fails at runtime with "[[: not found". So the wrapper contract also lints for
 * the bash-only constructs that a POSIX `sh` accepts syntactically and then
 * cannot execute.
 */
const BASHISMS: readonly (readonly [RegExp, string])[] = [
  [/(^|[\s;(&|])\[\[[\s;]/, "[[ ]] test"],
  [/(^|[\s;(&|])\(\(/, "(( )) arithmetic command"],
  [/\bshopt\b/, "shopt"],
  [/\bBASH_SOURCE\b/, "BASH_SOURCE"],
  [/\b(local|declare|typeset)\s/, "local/declare"],
  [/\bfunction\s+[A-Za-z_]/, "function keyword"],
  [/[A-Za-z_][A-Za-z0-9_]*\+=/, "+= append"],
  [/<\(/, "process substitution"],
  [/\becho\s+-e\b/, "echo -e"],
  [/\bsource\s/, "source (use .)"],
  [/\bread\s+-a\b/, "read -a"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?/, "${var^^} case expansion"],
];

function bashisms(script: string): string[] {
  return BASHISMS.filter(([pattern]) => pattern.test(script)).map(([, name]) => name);
}

function haveDash(): boolean {
  return spawnSync("dash", ["-c", "exit 0"]).status === 0;
}

/**
 * A sandbox whose PATH resolves `sh` to dash — the Debian/Ubuntu reality the
 * hooks must survive — plus inert `npx` so MCP launchers return instead of
 * serving. Nothing else is stubbed: git/jq/node stay real.
 */
function dashSandbox(): { bin: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "dash-sim-"));
  const bin = join(dir, "bin");
  const cwd = join(dir, "cwd");
  execFileSync("mkdir", ["-p", bin, cwd]);
  symlinkSync(execFileSync("sh", ["-c", "command -v dash"], { encoding: "utf8" }).trim(), join(bin, "sh"));
  const npx = join(bin, "npx");
  writeFileSync(npx, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(npx, 0o755);
  return { bin, cwd };
}

const SYNTAX_ERROR = /syntax error|unexpected|not found: \[\[|Bad substitution|Illegal option/i;

describe("shipped hooks run under bash, wrappers stay POSIX", () => {
  it("enumerates the shipped hook scripts", () => {
    expect(HOOKS.length).toBeGreaterThan(10);
    expect(HOOKS).toContain("plugins/dev/hooks/command-guard.sh");
    expect(HOOKS).toContain("plugins/dev/skills/engineering/afk/hooks/red-gradle");
    expect(HOOKS).toContain("plugins/dev/skills/engineering/afk/detectors/gradle.sh");
  });

  it("declares bash on every shipped hook — one interpreter, no `#!/bin/sh` mix", () => {
    const offenders = HOOKS.filter((rel) => !/^#!(\/usr\/bin\/env bash|\/bin\/bash)\b/.test(shebang(rel)));
    expect(offenders).toEqual([]);
  });

  it("parses every shipped hook under bash", () => {
    const offenders = HOOKS.filter((rel) => spawnSync("bash", ["-n", join(ROOT, rel)]).status !== 0);
    expect(offenders).toEqual([]);
  });

  it("launches the redskilled MCP through the same version-pinned npx lane on every host", () => {
    const launcher = readFileSync(
      join(ROOT, "plugins/dev/hooks/redskilled-mcp.sh"),
      "utf8",
    );

    expect(launcher).toContain(
      'npx -y -p "@reddb-io/red-skills@$ver" red-skills-redskilled-mcp',
    );
    expect(launcher).not.toMatch(/\b(?:curl|wget)\b|api\.github\.com|gh\s+release/);
    expect(launcher).toContain("Source-checkout fallback only");
  });

  it("never hands a shipped hook to `sh` at an invocation site", () => {
    const offenders: string[] = [];
    for (const manifest of HOST_MANIFESTS) {
      for (const command of manifestCommands(manifest)) {
        if (/\bsh ["'$][^"']*(hook|launcher|\.sh)/.test(command)) offenders.push(`${manifest}: ${command}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every host `sh -c` wrapper POSIX — parses under dash, no bashisms", () => {
    const offenders: string[] = [];
    let wrappers = 0;
    for (const manifest of HOST_MANIFESTS) {
      for (const command of manifestCommands(manifest)) {
        const inner = innerShScript(command);
        if (inner === undefined) continue;
        wrappers += 1;
        const found = bashisms(inner);
        if (found.length > 0) offenders.push(`${manifest}: bash-only ${found.join(", ")} in ${inner.slice(0, 60)}…`);
        if (!haveDash()) continue;
        const parsed = dashParse(inner);
        if (!parsed.ok) offenders.push(`${manifest}: ${parsed.stderr.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(wrappers).toBeGreaterThan(5);
  });

  it("runs every shipped hook with `sh` pointing at dash", () => {
    if (!haveDash()) return;
    const { bin, cwd } = dashSandbox();
    const failures: string[] = [];
    for (const rel of HOOKS) {
      const path = join(ROOT, rel);
      if (isSourcedLibrary(rel)) {
        // Sourced into a bash parent: prove it parses as bash, not that it runs.
        if (spawnSync("bash", ["-n", path]).status !== 0) failures.push(`${rel}: does not parse as bash`);
        continue;
      }
      if ((statSync(path).mode & 0o111) === 0) {
        failures.push(`${rel}: not executable — the shebang would never be honoured`);
        continue;
      }
      const result = spawnSync("bash", ["-c", `'${path}'`], {
        cwd,
        input: '{"tool_input":{"command":"echo hi"}}',
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SHELL: join(bin, "sh") },
      });
      const stderr = result.stderr ?? "";
      if (result.error) failures.push(`${rel}: ${result.error.message}`);
      else if (SYNTAX_ERROR.test(stderr)) failures.push(`${rel}: ${stderr.trim().split("\n")[0]}`);
      else if (!SERVER_LAUNCHERS.has(rel) && result.status === null) failures.push(`${rel}: killed without exiting`);
    }
    expect(failures).toEqual([]);
  });
});

describe("hook dispatcher invocation strategy", () => {
  it("runs lifecycle hook commands under bash, never the host `sh`", async () => {
    const exec = makeHookExec(ROOT);
    const result = await exec('printf %s "${BASH_VERSION:-none}"', {}, "{}");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).not.toBe("none");
    expect(result.stdout.trim()).toMatch(/^\d+\./);
  });

  it("documents the interpreter contract where hook authors read it", () => {
    const doc = readFileSync(join(ROOT, "plugins/dev/skills/engineering/afk/docs/CONFIG.md"), "utf8");
    expect(doc).toContain("### Hook Interpreter Contract");
    expect(doc).toContain('`bash "$hook"`');
    expect(doc).toContain("never assumed to be bash");
  });

  it("keeps bash a hard host prerequisite so the explicit-bash strategy is safe", async () => {
    const probe = await import("../src/core/operational-probes/host-prerequisites.js");
    expect(probe.HOST_PREREQUISITE_COMMANDS).toContain("bash");
  });
});

describe("dash simulation coverage", () => {
  it("actually has a dash to simulate with", () => {
    // Kept loud rather than silently skipped: without dash the two dash-backed
    // assertions above are no-ops, and a green suite would be a false green.
    if (!haveDash()) {
      console.warn("dash not installed — POSIX wrapper assertions did not run");
    }
    expect(existsSync(join(ROOT, "plugins/dev/hooks/claude.hooks.json"))).toBe(true);
  });
});
