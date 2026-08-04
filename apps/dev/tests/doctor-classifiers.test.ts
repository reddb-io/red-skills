import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDoctorClassifierReports,
  collectRedTaxonomyEntries,
  extractAskRedRouterSkills,
  type DoctorClassifierOptions,
} from "../src/runtime/doctor-classifiers.js";
import type { RepoContext } from "../src/runtime/wire/paths.js";

/**
 * Posed repositories, one per newly wired check (#3034). Each seeds the exact
 * defect the SKILL.md documents and asserts the documented finding comes back —
 * the half a pure classifier's own unit test cannot prove, because it is handed
 * facts rather than a repo.
 */

const roots: string[] = [];

async function poseRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function write(root: string, relative: string, contents: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/**
 * Never let a posed repo reach the tracker, the network, this host's `tq`, or
 * this host's installed agent CLIs.
 */
const OFFLINE: DoctorClassifierOptions = {
  collectDocsSweep: async (_ctx, base) => ({ base, files: [], originReachable: true }),
  listDependencyEdges: async () => ({ tickets: [], unread: [] }),
  readToolVersion: async () => undefined,
  readMarketplaceList: async () => ({ present: false }),
  readPorcelainStatus: async () => "",
};

function repoContext(root: string, repo = ""): RepoContext {
  return { root, repo, remote: "origin" };
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("check 12 — AFK hook / backpressure static validation", () => {
  it("reports a renamed package script, an unresolvable red-* target, and an unknown hook name", async () => {
    const root = await poseRoot("doctor-hooks-");
    await write(root, "package.json", JSON.stringify({ name: "posed", scripts: { test: "vitest" } }));
    await write(
      root,
      ".red/config.yaml",
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      backpressure:",
        "        - pnpm run gone",
        "        - red-nonexistent",
        "      hooks:",
        "        pre_wrktree: echo typo",
        "",
      ].join("\n"),
    );

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.hooks.backpressure).toEqual([
      { command: "pnpm run gone", verdict: "error", reason: 'package.json has no script "gone"' },
      { command: "red-nonexistent", verdict: "error", reason: 'no library/shadow hook named "red-nonexistent"' },
    ]);
    expect(reports.hooks.unknownHooks).toEqual(["pre_wrktree"]);
    // The registry supplies the exit-code policy, so an unknown point is not
    // silently rendered as if it aborted (or did not abort) the step.
    expect(reports.hookPoints).toContainEqual({ hook: "pre_wrktree", exit: "unknown", commands: 1 });
  });

  it("passes a resolvable backpressure command and names the point's exit policy", async () => {
    const root = await poseRoot("doctor-hooks-clean-");
    await write(root, "package.json", JSON.stringify({ name: "posed", scripts: { test: "vitest" } }));
    await write(
      root,
      ".red/config.yaml",
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      backpressure:",
        "        - pnpm run test",
        "      hooks:",
        "        pre_merge: red-validation",
        "",
      ].join("\n"),
    );

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.hooks.backpressure).toEqual([
      { command: "pnpm run test", verdict: "ok", reason: 'package.json script "test" exists' },
    ]);
    expect(reports.hooks.unknownHooks).toEqual([]);
    expect(reports.hookPoints).toEqual([{ hook: "pre_merge", exit: "abort", commands: 1 }]);
  });

  it("classifies a hook script in the .red/hooks tree and pre-catches an unknown point dir", async () => {
    const root = await poseRoot("doctor-hooks-tree-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");
    await write(root, ".red/hooks/pre_session/10-warm.sh", "#!/bin/sh\n");
    await write(root, ".red/hooks/pre_sesion/10-typo.sh", "#!/bin/sh\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.hooks.hooks.map((entry) => [entry.hook, entry.finding.verdict])).toEqual(
      expect.arrayContaining([["pre_session", "ok"], ["pre_sesion", "ok"]]),
    );
    expect(reports.hooks.unknownHooks).toEqual(["pre_sesion"]);
  });
});

describe("AFK worktree setup declaration audit (#3268)", () => {
  it("re-checks hook-manager repositories for a safe declared setup command", async () => {
    const root = await poseRoot("doctor-worktree-setup-");
    await write(
      root,
      "package.json",
      JSON.stringify({
        name: "posed",
        packageManager: "pnpm@11.5.0",
        scripts: { prepare: "lefthook install" },
        devDependencies: { lefthook: "1.12.0" },
      }),
    );
    await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const missing = await collectDoctorClassifierReports(repoContext(root), OFFLINE);
    expect(missing.worktreeSetup.verdict).toBe("error");
    expect(missing.worktreeSetup.findings[0]?.reason).toContain("plugins.dev.afk.setup is undeclared");

    await write(
      root,
      ".red/config.yaml",
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      setup: LEFTHOOK=0 pnpm install --frozen-lockfile",
        "",
      ].join("\n"),
    );
    const safe = await collectDoctorClassifierReports(repoContext(root), OFFLINE);
    expect(safe.worktreeSetup.verdict).toBe("ok");
  });
});

describe("check 13 — per-plugin runtime distribution", () => {
  it("reports an enabled plugin whose cached runtime never arrived", async () => {
    const root = await poseRoot("doctor-runtime-");
    const cacheDir = await poseRoot("doctor-runtime-cache-");
    await write(root, ".red/config.yaml", "plugins:\n  memory:\n    enabled: true\n");
    await write(root, "plugins/memory/.claude-plugin/plugin.json", JSON.stringify({ name: "memory", version: "3.3.2" }));

    process.env.RED_SKILLS_CACHE_DIR = cacheDir;
    try {
      const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);
      expect(reports.runtime.findings).toEqual([
        {
          plugin: "memory",
          kind: "runtime-missing",
          verdict: "error",
          reason: "enabled but runtime missing — no cached bundle for memory@3.3.2",
          remediation: "re-trigger the launcher fetch (red-fetch.mjs <plugin> <version>) or rebuild locally",
          fixGate: "confirm",
        },
      ]);
      expect(reports.runtime.rows).toEqual([
        { plugin: "memory", enabled: true, state: "missing", verdict: "error" },
      ]);
      // An unstamped checkout names no distributed `dev` runtime, so `dev` is
      // unaudited rather than reported missing under the build-info sentinel.
      expect(reports.runtimeUnresolved).toEqual(["dev", "brain"]);
    } finally {
      delete process.env.RED_SKILLS_CACHE_DIR;
    }
  });

  it("reads the inert marker a failed fetch left behind as its own finding", async () => {
    const root = await poseRoot("doctor-runtime-inert-");
    const cacheDir = await poseRoot("doctor-runtime-inert-cache-");
    await write(root, ".red/config.yaml", "plugins:\n  brain:\n    enabled: true\n");
    await write(root, "plugins/brain/.claude-plugin/plugin.json", JSON.stringify({ name: "brain", version: "1.2.3" }));
    await mkdir(join(cacheDir, ".staging-brain-1.2.3"), { recursive: true });

    process.env.RED_SKILLS_CACHE_DIR = cacheDir;
    try {
      const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);
      expect(reports.runtime.findings.map((finding) => finding.kind)).toEqual(["inert-marker"]);
    } finally {
      delete process.env.RED_SKILLS_CACHE_DIR;
    }
  });

  it("leaves a disabled plugin inert by design and names plugins it could not version", async () => {
    const root = await poseRoot("doctor-runtime-disabled-");
    const cacheDir = await poseRoot("doctor-runtime-disabled-cache-");
    await write(root, ".red/config.yaml", "plugins:\n  memory:\n    enabled: false\n");
    await write(root, "plugins/memory/.claude-plugin/plugin.json", JSON.stringify({ name: "memory", version: "3.3.2" }));

    process.env.RED_SKILLS_CACHE_DIR = cacheDir;
    try {
      const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);
      expect(reports.runtime.findings).toEqual([]);
      expect(reports.runtime.rows).toEqual([
        { plugin: "memory", enabled: false, state: "disabled", verdict: "skip" },
      ]);
      // `dev` and `brain` have no manifest here: unaudited and SAID SO, never a
      // bundle reported missing under a version nobody ever named.
      expect(reports.runtimeUnresolved).toEqual(["dev", "brain"]);
    } finally {
      delete process.env.RED_SKILLS_CACHE_DIR;
    }
  });
});

describe("check 18 — required host binary pins", () => {
  it("names catalog, config, and observed versions on tq toolchain drift", async () => {
    const root = await poseRoot("doctor-host-binary-");
    await write(root, "pnpm-workspace.yaml", "catalog:\n  '@reddb-io/toon': 0.3.0\n");
    await write(
      root,
      ".red/config.yaml",
      "host_binaries:\n  tq:\n    version: 0.2.0\nplugins:\n  dev:\n    enabled: true\n",
    );

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      readToolVersion: async () => "0.0.9",
    });

    expect(reports.hostBinaries.findings).toEqual([
      {
        binary: "tq",
        kind: "toolchain-drift",
        verdict: "error",
        reason: "required host binary tq toolchain drift: catalog pin 0.3.0, config pin 0.2.0, observed tq 0.0.9",
        remediation:
          "install pinned tq with: TQ_VERSION=v0.3.0 curl -fsSL https://raw.githubusercontent.com/reddb-io/toon/v0.3.0/install.sh | sh",
      },
    ]);
  });

  it("skips the pin audit, with a named note, in a repo that has no catalog", async () => {
    const root = await poseRoot("doctor-host-binary-nocatalog-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.hostBinaries.rows).toEqual([]);
    expect(reports.notes.some((note) => note.startsWith("host binary pin audit skipped:"))).toBe(true);
  });
});

describe("check 26 — marketplace registration source", () => {
  it("flags the Directory-sourced red-skills marketplace the installer used to write", async () => {
    const root = await poseRoot("doctor-marketplace-");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      readMarketplaceList: async (host) =>
        host === "claude"
          ? {
              present: true,
              output: "Configured marketplaces:\n\n  ❯ red-skills\n    Source: Directory (/home/user/.red-skills/current)\n",
            }
          : { present: false },
    });

    expect(reports.marketplaceSources.findings).toHaveLength(1);
    const finding = reports.marketplaceSources.findings[0]!;
    expect(finding.host).toBe("claude");
    expect(finding.kind).toBe("frozen-directory-source");
    expect(finding.remediation).toBe(
      "claude plugin marketplace remove red-skills && claude plugin marketplace add reddb-io/red-skills",
    );
  });

  it("passes a GitHub-sourced registration and an uninstalled host clean", async () => {
    const root = await poseRoot("doctor-marketplace-healthy-");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      readMarketplaceList: async (host) =>
        host === "claude"
          ? {
              present: true,
              output: "Configured marketplaces:\n\n  ❯ red-skills\n    Source: GitHub (reddb-io/red-skills)\n",
            }
          : { present: false },
    });

    expect(reports.marketplaceSources.findings).toEqual([]);
    expect(reports.marketplaceSources.rows.map((row) => row.verdict)).toEqual(["ok", "ok"]);
  });
});

describe("check 15 — native blocked-by vs req:N divergence", () => {
  it("reports divergence in both directions and never hides an unread Ticket", async () => {
    const root = await poseRoot("doctor-dependency-edges-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root, "acme/widgets"), {
      ...OFFLINE,
      listDependencyEdges: async () => ({
        tickets: [
          { number: 11, labels: ["req:5"], nativeBlockedBy: [] },
          { number: 12, labels: [], nativeBlockedBy: [7] },
          { number: 13, labels: ["req:9"], nativeBlockedBy: [9] },
        ],
        unread: [400, 401],
      }),
    });

    expect(reports.dependencyEdges.findings.map((finding) => [finding.ticket, finding.kind])).toEqual([
      [11, "req-label-without-native"],
      [12, "native-without-req-label"],
    ]);
    expect(reports.dependencyEdgesUnread).toEqual([400, 401]);
  });

  it("skips the audit with a named note when the repo has no issue tracker", async () => {
    const root = await poseRoot("doctor-dependency-edges-notracker-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.dependencyEdges.rows).toEqual([]);
    expect(reports.notes).toContain("dependency-edge audit skipped: no issue tracker for this repo");
  });
});

describe("check 17 — ask-red router coverage sync", () => {
  it("flags a registered skill missing from the router and a stale router entry", async () => {
    const root = await poseRoot("doctor-ask-red-");
    await write(
      root,
      "plugins/dev/.claude-plugin/plugin.json",
      JSON.stringify({ name: "dev", skills: ["./skills/engineering/afk", "./skills/engineering/go"] }),
    );
    await write(
      root,
      "plugins/dev/skills/engineering/ask-red/SKILL.md",
      "# ask-red\n\nRoutes `/afk` and `/ghost-flow`.\n",
    );

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.askRedRouter.findings).toEqual([
      {
        skill: "go",
        kind: "missing-from-router",
        verdict: "warn",
        reason: "registered skill /go is missing from ask-red",
        remediation: "update ask-red so the router covers the registered skill set",
      },
      {
        skill: "ghost-flow",
        kind: "stale-router-entry",
        verdict: "warn",
        reason: "ask-red routes /ghost-flow but that skill is not registered",
        remediation: "update ask-red so the router covers the registered skill set",
      },
    ]);
  });

  // A fenced block with an odd backtick re-pairs every inline span after it, so
  // a naive extractor loses half the router and invents `missing-from-router`
  // findings for skills the router does name.
  it("survives a fenced code block between two route mentions", () => {
    const markdown = [
      "Routes `/afk`.",
      "",
      "```bash",
      "echo `date`",
      "```",
      "",
      "Also routes `/triage` and `/memory:wiki`.",
    ].join("\n");

    expect(extractAskRedRouterSkills(markdown)).toEqual(["afk", "triage"]);
  });

  it("stays green against this repo's own manifest and router", async () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..");

    const reports = await collectDoctorClassifierReports(repoContext(repoRoot), OFFLINE);

    expect(reports.askRedRouter.findings).toEqual([]);
  });
});

describe("check 19 — .red lifecycle taxonomy", () => {
  it("reports a loose tmp file, an unregistered lane, and an undocumented .red root", async () => {
    const root = await poseRoot("doctor-taxonomy-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");
    await write(root, ".red/tmp/rsp.wake.lock", "");
    await mkdir(join(root, ".red/tmp/mystery-lane"), { recursive: true });
    await mkdir(join(root, ".red/tmp/worktrees/mystery"), { recursive: true });
    await mkdir(join(root, ".red/undocumented"), { recursive: true });

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.redTaxonomy.findings.map((finding) => [finding.path, finding.kind])).toEqual([
      [".red/tmp/mystery-lane", "unknown-tmp-lane"],
      [".red/tmp/rsp.wake.lock", "loose-tmp-file"],
      [".red/tmp/worktrees/mystery", "unknown-tmp-lane"],
      [".red/undocumented", "undocumented-red-root"],
    ]);
  });

  it("enumerates exactly the three levels ADR 0098's classifier rules on", async () => {
    const root = await poseRoot("doctor-taxonomy-levels-");
    await mkdir(join(root, ".red/tmp/workers/abc/123"), { recursive: true });
    await mkdir(join(root, ".red/tmp/worktrees/manual"), { recursive: true });

    const entries = collectRedTaxonomyEntries(root).map((entry) => entry.path);

    expect(entries).toEqual([".red/tmp", ".red/tmp/workers", ".red/tmp/worktrees", ".red/tmp/worktrees/manual"]);
  });

  it("passes a repo whose .red tree is entirely registered lanes", async () => {
    const root = await poseRoot("doctor-taxonomy-clean-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");
    await mkdir(join(root, ".red/tmp/workers"), { recursive: true });
    await mkdir(join(root, ".red/tmp/worktrees/manual"), { recursive: true });
    await mkdir(join(root, ".red/adr"), { recursive: true });

    const reports = await collectDoctorClassifierReports(repoContext(root), OFFLINE);

    expect(reports.redTaxonomy.findings).toEqual([]);
  });
});

describe("check 21 — unlanded .red docs", () => {
  it("reports the shared Docs Sweep file list as a warn with the ADR 0092 fix-home", async () => {
    const root = await poseRoot("doctor-unlanded-docs-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      collectDocsSweep: async (_ctx, base) => ({
        base,
        originReachable: true,
        files: [
          { path: ".red/adr/0135-posed.md", state: "untracked", group: "adr", ignored: false, trackedPrecedent: true },
        ],
      }),
    });

    expect(reports.unlandedDocs.row).toEqual({
      check: "unlanded-red-docs",
      verdict: "warn",
      evidence: "untracked:.red/adr/0135-posed.md",
      fixHome: "→ ADR 0092 doc-landing lane",
    });
    expect(reports.unlandedDocs.findings.map((finding) => finding.kind)).toEqual(["unlanded-docs"]);
  });

  it("reports an unreachable origin as an error rather than a clean sweep", async () => {
    const root = await poseRoot("doctor-unlanded-docs-halt-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      collectDocsSweep: async (_ctx, base) => ({
        base,
        originReachable: false,
        files: [
          { path: ".red/CONTEXT.md", state: "modified", group: "glossary", ignored: false, trackedPrecedent: true },
        ],
      }),
    });

    expect(reports.unlandedDocs.row.verdict).toBe("error");
    expect(reports.unlandedDocs.findings.map((finding) => finding.kind)).toEqual(["landing-blocked"]);
  });

  it("degrades to a named note when the docs read itself fails", async () => {
    const root = await poseRoot("doctor-unlanded-docs-degraded-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      collectDocsSweep: async () => {
        throw new Error("git fetch refused");
      },
    });

    expect(reports.unlandedDocs.row.verdict).toBe("ok");
    expect(reports.notes).toContain("unlanded .red docs audit unavailable: git fetch refused");
  });
});

describe("check 28 — uncommitted /red-setup output (#3106)", () => {
  it("warns with the paths setup wrote and never committed", async () => {
    const root = await poseRoot("doctor-setup-dirt-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      readPorcelainStatus: async () => " M .red/config.yaml\n?? .red/.gitignore\n M apps/dev/src/x.ts\n",
    });

    expect(reports.setupOwnedDirt.row.check).toBe("setup-owned-dirt");
    expect(reports.setupOwnedDirt.row.verdict).toBe("warn");
    expect(reports.setupOwnedDirt.row.evidence).toContain(".red/config.yaml");
    expect(reports.setupOwnedDirt.row.evidence).toContain(".red/.gitignore");
    // The operator's own WIP is not this check's business.
    expect(reports.setupOwnedDirt.row.evidence).not.toContain("apps/dev/src/x.ts");
    expect(reports.setupOwnedDirt.findings.map((finding) => finding.kind)).toEqual([
      "uncommitted-setup-files",
    ]);
  });

  it("is ok when nothing setup wrote is pending", async () => {
    const root = await poseRoot("doctor-setup-dirt-clean-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      readPorcelainStatus: async () => " M apps/dev/src/x.ts\n",
    });

    expect(reports.setupOwnedDirt.row.verdict).toBe("ok");
    expect(reports.setupOwnedDirt.findings).toEqual([]);
  });

  it("degrades to a named note when git status cannot be read", async () => {
    const root = await poseRoot("doctor-setup-dirt-degraded-");
    await write(root, ".red/config.yaml", "plugins:\n  dev:\n    enabled: true\n");

    const reports = await collectDoctorClassifierReports(repoContext(root), {
      ...OFFLINE,
      readPorcelainStatus: async () => {
        throw new Error("not a git repository");
      },
    });

    expect(reports.setupOwnedDirt.row.verdict).toBe("ok");
    expect(reports.notes).toContain("uncommitted /red-setup output audit unavailable: not a git repository");
  });
});
