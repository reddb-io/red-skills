/**
 * Tests for the workspace-root resolution (issue #3972).
 *
 * The regression this pins: the navigator is launched from a script inside the
 * plugin installation, so `process.cwd()` was frequently the PLUGIN and every
 * navigation answered against the wrong tree. The standalone integration test
 * at the bottom is the real proof — it spawns the binary the way a host does
 * (cwd = the plugin install) and reads the root off the ready line.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPluginInstallDir, resolveWorkspaceRoot } from "../src/workspace-root.js";

const REPO = resolve(__dirname, "../../..");
const ENTRY = resolve(REPO, "apps/code-nav/src/index.ts");

// pnpm's isolated layout keeps the bin package-local; a hoisted install puts it
// at the repo root. Same discovery the cli-smoke suite uses.
const TSX = [
  resolve(REPO, "apps/code-nav/node_modules/.bin/tsx"),
  resolve(REPO, "node_modules/.bin/tsx"),
].find((candidate) => existsSync(candidate));

let scratch: string;
let project: string;
let pluginInstall: string;

beforeAll(() => {
  // realpath: the temp dir is a symlink on some platforms, and the child
  // process reports the resolved cwd — the two must be comparable.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "code-nav-root-")));
  project = join(scratch, "my-repo");
  pluginInstall = join(scratch, "installed", "dev");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
  mkdirSync(join(pluginInstall, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginInstall, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "dev", version: "0.0.0" }),
    "utf8",
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("isPluginInstallDir", () => {
  it("recognises a directory carrying a plugin manifest", () => {
    expect(isPluginInstallDir(pluginInstall, {})).toBe(true);
    expect(isPluginInstallDir(project, {})).toBe(false);
  });

  it("recognises the plugin root the host announced", () => {
    expect(isPluginInstallDir(project, { CLAUDE_PLUGIN_ROOT: project })).toBe(true);
    expect(isPluginInstallDir(project, { CODEX_PLUGIN_ROOT: project })).toBe(true);
  });

  it("recognises the well-known host plugin caches by path", () => {
    expect(isPluginInstallDir("/home/u/.claude/plugins/cache/red-skills/dev", {})).toBe(true);
    expect(isPluginInstallDir("/home/u/.codex/plugins/cache/red-skills/dev", {})).toBe(true);
    expect(
      isPluginInstallDir("/home/u/.codex/.tmp/marketplaces/red-skills/plugins/dev", {}),
    ).toBe(true);
    expect(isPluginInstallDir("/home/u/work/red-skills", {})).toBe(false);
  });
});

describe("resolveWorkspaceRoot", () => {
  it("obeys CODE_NAV_ROOT as written", () => {
    const r = resolveWorkspaceRoot({ CODE_NAV_ROOT: project }, pluginInstall);
    expect(r.root).toBe(project);
    expect(r.source).toBe("CODE_NAV_ROOT");
  });

  it("follows the project the host announces over the cwd", () => {
    for (const key of [
      "RED_SKILLS_PROJECT_ROOT",
      "CLAUDE_PROJECT_DIR",
      "CODEX_PROJECT_DIR",
      "OPENCODE_PROJECT_DIR",
    ]) {
      const r = resolveWorkspaceRoot({ [key]: project }, pluginInstall);
      expect(r.root).toBe(project);
      expect(r.source).toBe(key);
    }
  });

  it("prefers CODE_NAV_ROOT over a host-announced project", () => {
    const r = resolveWorkspaceRoot(
      { CODE_NAV_ROOT: project, CLAUDE_PROJECT_DIR: pluginInstall },
      scratch,
    );
    expect(r.root).toBe(project);
  });

  it("skips a host-announced directory that is really the plugin install", () => {
    const r = resolveWorkspaceRoot(
      { CLAUDE_PROJECT_DIR: pluginInstall, CODEX_PROJECT_DIR: project },
      scratch,
    );
    expect(r.root).toBe(project);
    expect(r.source).toBe("CODEX_PROJECT_DIR");
  });

  it("falls back to the cwd when nothing announces a project", () => {
    const r = resolveWorkspaceRoot({}, project);
    expect(r.root).toBe(project);
    expect(r.source).toBe("cwd");
    expect(r.warning).toBeUndefined();
  });

  it("warns when the only candidate left is the plugin installation", () => {
    const r = resolveWorkspaceRoot({}, pluginInstall);
    expect(r.root).toBe(pluginInstall);
    expect(r.warning).toMatch(/plugin installation/);
    expect(r.warning).toMatch(/CODE_NAV_ROOT/);
  });

  it("ignores an empty or whitespace-only announcement", () => {
    const r = resolveWorkspaceRoot({ CLAUDE_PROJECT_DIR: "   " }, project);
    expect(r.root).toBe(project);
    expect(r.source).toBe("cwd");
  });
});

/**
 * The integration proof: launch the navigator the way a host does — cwd inside
 * the plugin installation — and read the workspace root back off the ready
 * line it writes to stderr. Nothing here needs a language server: the sessions
 * are opened lazily on the first tool call.
 */
function launchAndReadRoot(
  cwd: string,
  env: Record<string, string>,
): Promise<{ root: string; source: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (TSX === undefined) {
      rejectPromise(new Error("tsx not installed; run `pnpm install`"));
      return;
    }
    const child = spawn(TSX, [ENTRY], {
      cwd,
      env: {
        ...process.env,
        // Strip any project announcement the surrounding test runner exported,
        // so the case under test is the only thing deciding.
        CODE_NAV_ROOT: undefined,
        RED_SKILLS_PROJECT_ROOT: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        CODEX_PROJECT_DIR: undefined,
        OPENCODE_PROJECT_DIR: undefined,
        CLAUDE_PLUGIN_ROOT: undefined,
        CODEX_PLUGIN_ROOT: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/navigator MCP ready \(root=(.+?), root-source=(.+?),/);
      if (match) {
        child.kill("SIGKILL");
        resolvePromise({ root: match[1]!, source: match[2]!, stderr });
      }
    });
    child.on("error", (err) => {
      child.kill("SIGKILL");
      rejectPromise(err);
    });
    child.on("exit", () => {
      if (!/navigator MCP ready/.test(stderr)) {
        rejectPromise(new Error(`navigator exited before it was ready:\n${stderr}`));
      }
    });
  });
}

describe("standalone navigator (integration)", () => {
  it("indexes the opened project, not the plugin installation it launched from", async () => {
    const observed = await launchAndReadRoot(pluginInstall, { CLAUDE_PROJECT_DIR: project });
    expect(observed.root).toBe(project);
    expect(observed.root).not.toBe(pluginInstall);
    expect(observed.source).toBe("CLAUDE_PROJECT_DIR");
  }, 60_000);

  it("says so on stderr when the plugin installation is all it has", async () => {
    const observed = await launchAndReadRoot(pluginInstall, {});
    expect(observed.root).toBe(pluginInstall);
    expect(observed.stderr).toMatch(/plugin installation/);
  }, 60_000);
});
