import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const obsoleteHitl = `slice:${"hitl"}`;
const obsoleteAfk = `slice:${"afk"}`;
const obsoleteGlob = `slice:${"*"}`;
const manualImplRequires = `requires human ${"implementation"}`;
const manualImplNeeds = `needs human ${"implementation"}`;

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

function writeFakeRuntime(root: string, label: string): void {
  const bin = join(root, "skills", "engineering", "afk", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "afk.mjs"),
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ label: ${JSON.stringify(label)}, args: process.argv.slice(2) }));\n`,
  );
}

function shimEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CODEX_PLUGIN_ROOT;
  delete env.OPENCODE_PLUGIN_ROOT;
  delete env.RED_SKILLS_DEV_PLUGIN_ROOT;
  return Object.assign(env, extra);
}

describe("label vocabulary docs", () => {
  it("teaches publishers to write native dependency edges and req labels together", async () => {
    const toTickets = await readRepoFile("plugins/dev/skills/engineering/to-tickets/SKILL.md");
    const triage = await readRepoFile("plugins/dev/skills/engineering/triage/SKILL.md");

    for (const skill of [toTickets, triage]) {
      expect(skill).toContain("native sub-issue relationship");
      expect(skill).toContain("native blocked-by relationship");
      expect(skill).toContain("req:N labels remain the machine truth");
      expect(skill).toContain("human surface");
      expect(skill).toContain("Do not clean up either side");
    }
  });

  it("keeps the Blocked by body fallback beside native dependency edges", async () => {
    const toTickets = await readRepoFile("plugins/dev/skills/engineering/to-tickets/SKILL.md");
    const triage = await readRepoFile("plugins/dev/skills/engineering/triage/SKILL.md");

    for (const skill of [toTickets, triage]) {
      expect(skill).toContain("body fallback");
      expect(skill).toContain("## Blocked by");
      expect(skill).toContain("- [ ] #N");
    }
  });

  it("does not teach obsolete slice-routing labels", async () => {
    const docs = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/setup-red-skills/triage-labels.md"),
      readRepoFile("plugins/dev/skills/engineering/hitl/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/to-tickets/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/triage/SKILL.md"),
      readRepoFile("README.md"),
    ]);

    for (const doc of docs) {
      expect(doc).not.toContain(obsoleteHitl);
      expect(doc).not.toContain(obsoleteAfk);
      expect(doc).not.toContain(obsoleteGlob);
    }
  });

  it("defines ready-for-human as human decision or resolution", async () => {
    const canonical = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/triage-labels.md");

    expect(canonical).toContain(
      "The issue requires human decision or resolution before it can proceed or be delegated.",
    );
    expect(canonical).not.toContain(manualImplRequires);
    expect(canonical).not.toContain(manualImplNeeds);
  });
});

describe("setup-red-skills docs", () => {
  it("documents Section H as the development-workflow activation on-ramp", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    const template = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/config-template.yaml");

    expect(skill).toContain("**Section H — Development workflow.**");
    expect(skill).toContain("dev.lock.primary-branch: true");
    expect(skill).toContain("inject-development-workflow --root");
    expect(skill).toContain("both `AGENTS.md` and `CLAUDE.md`");
    expect(skill).toContain("`/go` for one-off concrete work");
    // ADR 0067: the template now carries an active `plugins:` activation block
    // (dev enabled by default) with the dev lock example folded under it.
    expect(template).toContain("plugins:");
    expect(template).toContain("enabled: true");
    expect(template).toContain("#     primary-branch: true");
  });

  it("documents command guards as repo-owned proxy policy", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    const template = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/config-template.yaml");
    const readme = await readRepoFile("README.md");

    expect(skill).toContain("**Section G1 — Command guards");
    expect(skill).toContain("hooks are **proxy guarantees**, not the policy source");
    expect(skill).toContain("Built-in invariant: when `plugins.dev.enabled: true`");
    expect(skill).toContain("Agent-created `git worktree add` destinations must resolve under the repo's `.red/tmp/`");
    expect(skill).toContain("Examples are examples only");
    expect(skill).toContain("command_guard.global");
    expect(skill).toContain("command_guard.main");
    expect(skill).toContain("command_guard.worktree");
    expect(template).toContain("Built-in dev shell guard");
    expect(template).toContain("agent-created");
    expect(template).toContain("git worktree add .red/tmp/work-<slug>");
    expect(template).toContain("# command_guard:");
    expect(template).toContain("#   global:");
    expect(template).toContain("#   main:");
    expect(template).toContain("#   worktree:");
    expect(readme).toContain("Example policy, not a default:");
    expect(readme).toContain("git worktree add .red/tmp/work-<slug>");
  });

  it("documents the cross-cli runtime shim instead of global plugin-root env vars", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    const script = await readRepoFile(
      "plugins/dev/skills/engineering/setup-red-skills/scripts/install-runtime-shim.sh",
    );

    expect(skill).toContain("**Section E1 — Runtime launcher");
    expect(skill).toContain("stable command, not a global fake plugin-root variable");
    expect(skill).toContain("red-skills-dev go");
    expect(skill).toContain("Do not export `CLAUDE_PLUGIN_ROOT` or `CODEX_PLUGIN_ROOT` globally");
    expect(script).toContain("RED_SKILLS_DEV_PLUGIN_ROOT");
    expect(script).toContain(".codex/plugins/cache/red-skills/dev");
    expect(script).toContain(".claude/plugins/cache/red-skills/dev");
    expect(script).toContain(".cache/red-skills/bundles");
  });

  it("installs a runtime shim that prefers active env roots, then the highest host cache", () => {
    const tmp = mkdtempSync(join(tmpdir(), "red-runtime-shim-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const envRoot = join(tmp, "env-root");
    const script = join(ROOT, "plugins/dev/skills/engineering/setup-red-skills/scripts/install-runtime-shim.sh");

    try {
      writeFakeRuntime(envRoot, "env");
      writeFakeRuntime(join(home, ".codex", "plugins", "cache", "red-skills", "dev", "99.0.0"), "cache99");
      execFileSync("bash", [script], { env: { ...process.env, XDG_BIN_HOME: bin }, encoding: "utf8" });

      const envOutput = execFileSync(join(bin, "red-skills-dev"), ["ship", "--issue", "123"], {
        env: shimEnv(home, { RED_SKILLS_DEV_PLUGIN_ROOT: envRoot }),
        encoding: "utf8",
      }).trim();
      expect(JSON.parse(envOutput)).toEqual({ label: "env", args: ["ship", "--issue", "123"] });

      rmSync(home, { recursive: true, force: true });
      writeFakeRuntime(join(home, ".codex", "plugins", "cache", "red-skills", "dev", "1.0.0"), "codex1");
      writeFakeRuntime(join(home, ".claude", "plugins", "cache", "red-skills", "dev", "9.0.0"), "claude9");

      const cacheOutput = execFileSync(join(bin, "red-skills-dev"), ["dashboard", "--json"], {
        env: shimEnv(home),
        encoding: "utf8",
      }).trim();
      expect(JSON.parse(cacheOutput)).toEqual({ label: "claude9", args: ["dashboard", "--json"] });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("documents Section A0 plugin activation as the per-directory gate", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    expect(skill).toContain("**Section A0 — Plugin activation");
    expect(skill).toContain("plugins.<name>.enabled: true");
    expect(skill).toContain("authorized to create `.red/`");
  });
});
