/**
 * Tests for `generate.ts` — the CLI entrypoint. We exercise it through
 * `parseArgs` indirectly (by spawning the bundled file is not viable in
 * vitest) and through a direct `main` smoke that uses `process.argv`.
 *
 * For now the suite covers the pure `parseArgs` and the file-IO contract
 * via the public surface (`buildProviderBlock` already covers the pure
 * half in provider-block.test.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const GENERATE_ENTRY = resolve(REPO, "apps/opencode-host/src/generate.ts");

function writeFixturePlugins(root: string): void {
  const dev = join(root, "dev");
  mkdirSync(join(dev, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dev, "hooks"), { recursive: true });
  writeFileSync(join(dev, ".claude-plugin", "plugin.json"), "{}\n", "utf8");
  writeFileSync(
    join(dev, "hooks", "claude.hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "sh -c 'red-fetch.mjs run dev rsp-instructions --runner claude --hook'",
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "sh -c '\"${CLAUDE_PLUGIN_ROOT}/hooks/rsp-hook.sh\" claude-pre-exec'",
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );
}

function runGenerate(args: string[], env: Record<string, string | undefined>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  // The CI shell may have OPENAI_API_KEY / MINIMAX_API_KEY / OPENROUTER_API_KEY
  // exported (this is a real maintainer machine). Strip them from the inherited
  // env so the precedence rule under test starts from a clean slate, then
  // re-apply the caller-supplied entries.
  const cleaned: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "MINIMAX_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    delete cleaned[key];
  }
  Object.assign(cleaned, env);
  const result = spawnSync("pnpm", ["--filter", "@reddb-io/red-skills", "exec", "tsx", GENERATE_ENTRY, ...args], {
    cwd: REPO,
    env: cleaned,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("opencode-host generate (CLI smoke)", () => {
  it("prints help on --help and exits 0", () => {
    const r = runGenerate(["--help"], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("opencode-host generate");
    expect(r.stdout).toContain("--config");
  });

  it("rejects unknown args with exit 2 and names the flag", () => {
    const r = runGenerate(["--bogus"], {});
    // pnpm propagates the child exit code as 1 when non-zero (a quirk of
    // pnpm's recursive exec wrapper), so we accept either the documented
    // 2 or pnpm's 1. The contract under test is "non-zero + clear stderr".
    expect([1, 2]).toContain(r.status);
    expect(r.stderr).toMatch(/unknown flag '--bogus'/);
  });

  it("prints the build version on --version and -v", () => {
    for (const flag of ["--version", "-v"]) {
      const r = runGenerate([flag], {});
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^opencode-host \S+ \S+\n$/);
    }
  });

  it("prints the structured build info on --version --json", () => {
    const r = runGenerate(["--version", "--json"], {});
    expect(r.status).toBe(0);
    const info = JSON.parse(r.stdout) as { app: string; version: string; gitSha: string };
    expect(info.app).toBe("opencode-host");
    expect(typeof info.version).toBe("string");
    expect(typeof info.gitSha).toBe("string");
  });

  it("answers --version without reading a config or opening the gate", () => {
    // No --config exists at this path and the CWD's gate is irrelevant: the
    // version answer must come before either is touched.
    const r = runGenerate(["--version", "--config", "/nonexistent/config.yaml"], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^opencode-host /);
    expect(r.stderr).not.toMatch(/could not read config/);
  });

  it("refuses to emit when the dev plugin is not enabled (ADR 0067)", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-host-"));
    const config = join(dir, "config.yaml");
    writeFileSync(config, "plugins:\n  dev:\n    enabled: false\n", "utf8");
    const out = join(dir, "opencode.json");
    try {
      const r = runGenerate(["--config", config, "--out", out, "--no-slice-2"], {});
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing to emit/);
      expect(r.stderr).toMatch(/plugins\.dev\.enabled/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits opencode.json with the OpenRouter default when no env is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-host-"));
    const config = join(dir, "config.yaml");
    writeFileSync(config, "plugins:\n  dev:\n    enabled: true\n", "utf8");
    const out = join(dir, "opencode.json");
    try {
      const r = runGenerate(["--config", config, "--out", out, "--no-slice-2"], {});
      expect(r.status).toBe(0);
      const written = readFileSync(out, "utf8");
      const jsonStart = written.indexOf("{");
      const parsed = JSON.parse(written.slice(jsonStart)) as {
        model: string;
        provider: Record<string, unknown>;
      };
      expect(parsed.model).toBe("openrouter/anthropic/claude-3.5-sonnet");
      expect(Object.keys(parsed.provider).sort()).toEqual(["minimax", "openai", "openrouter"]);
      // header
      expect(written).toMatch(/^\/\/ generated by @reddb-io\/red-skills/);
      expect(r.stderr).toMatch(/no auth env-var set/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits the per-tier model and re-orders providers when MINIMAX_API_KEY is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-host-"));
    const config = join(dir, "config.yaml");
    writeFileSync(
      config,
      `plugins:
  dev:
    enabled: true
    afk:
      models:
        opencode:
          think:
            model: minimax/MiniMax-M3
`,
      "utf8",
    );
    const out = join(dir, "opencode.json");
    try {
      const r = runGenerate(["--config", config, "--out", out, "--no-slice-2"], { MINIMAX_API_KEY: "mn-test" });
      expect(r.status).toBe(0);
      const written = readFileSync(out, "utf8");
      expect(written).toContain("\"model\": \"minimax/MiniMax-M3\"");
      // Parse the JSON payload (after the header comment block) and check
      // that the active provider is the FIRST key in the emitted
      // `provider` object. Using a regex on raw text would be ambiguous
      // because `model: openrouter/...` also mentions the string.
      const jsonStart = written.indexOf("{");
      const parsed = JSON.parse(written.slice(jsonStart)) as {
        provider: Record<string, unknown>;
      };
      const providerKeys = Object.keys(parsed.provider);
      expect(providerKeys[0]).toBe("minimax");
      expect(providerKeys.sort()).toEqual(["minimax", "openai", "openrouter"]);
      // API key must not leak
      expect(written).not.toContain("mn-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--print writes the JSON to stdout instead of a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-host-"));
    const config = join(dir, "config.yaml");
    writeFileSync(config, "plugins:\n  dev:\n    enabled: true\n", "utf8");
    const out = join(dir, "should-not-exist.json");
    try {
      const r = runGenerate(["--config", config, "--out", out, "--print"], {});
      expect(r.status).toBe(0);
      const jsonStart = r.stdout.indexOf("{");
      const parsed = JSON.parse(r.stdout.slice(jsonStart)) as { model: string };
      expect(parsed.model).toBe("openrouter/anthropic/claude-3.5-sonnet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits the Slice 2 dist tree by default and allows opting out", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-host-"));
    const config = join(dir, "config.yaml");
    const plugins = join(dir, "plugins");
    const out = join(dir, "opencode.json");
    const outDir = join(dir, "dist", "opencode");
    writeFileSync(config, "plugins:\n  dev:\n    enabled: true\n", "utf8");
    writeFixturePlugins(plugins);
    try {
      const defaultRun = runGenerate(["--config", config, "--plugins-root", plugins, "--out", out, "--out-dir", outDir], {});
      expect(defaultRun.status).toBe(0);
      const preToolUse = readFileSync(join(outDir, "dev", ".opencode", "plugin", "pre-tool-use.ts"), "utf8");
      const sessionStart = readFileSync(join(outDir, "dev", ".opencode", "plugin", "session-start.ts"), "utf8");
      expect(preToolUse).toContain("__runRspRewrite");
      expect(sessionStart).toContain("--runner opencode --hook");

      rmSync(outDir, { recursive: true, force: true });
      const optOutRun = runGenerate([
        "--config",
        config,
        "--plugins-root",
        plugins,
        "--out",
        out,
        "--out-dir",
        outDir,
        "--no-slice-2",
      ], {});
      expect(optOutRun.status).toBe(0);
      expect(() => readFileSync(join(outDir, "dev", ".opencode", "plugin", "pre-tool-use.ts"), "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
