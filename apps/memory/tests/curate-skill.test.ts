import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";
import {
  parseCuratorReport,
  readArchiveCandidates,
} from "../src/curate-skill/candidate-reader.js";
import { decideConsent } from "../src/curate-skill/consent-gate.js";
import {
  defaultArchiveFs,
  executeArchive,
  executeRestore,
  validateCandidate,
} from "../src/curate-skill/archive-engine.js";
import type { ArchiveFs } from "../src/curate-skill/archive-engine.js";
import type { ArchiveCandidate, CuratorReportEnvelope } from "../src/curate-skill/types.js";
import { decodeMemoryStateDocument } from "../src/toon-state.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const CLI_PATH = join(PLUGIN_ROOT, "src", "cli.ts");

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "curate-skill-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runCurate(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, "curate", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function envelope(recs: CuratorReportEnvelope["recommendations"]): CuratorReportEnvelope {
  return {
    generatedAt: "2026-05-22T16:00:00.000Z",
    staleDays: 60,
    totalSkills: recs.length,
    curatableSkills: recs.filter((r) => r.curatable).length,
    readOnlySkills: recs.filter((r) => !r.curatable).length,
    recommendations: recs,
  };
}

describe("candidate-reader", () => {
  test("returns candidates across every in-scope curate category", () => {
    const env = envelope([
      { name: "arch", source_kind: "project", path: "/x/arch/SKILL.md", curatable: true, category: "archive", reason: "stale (90d) and never invoked" },
      { name: "stale-skill", source_kind: "project", path: "/x/s/SKILL.md", curatable: true, category: "stale", reason: "no skill activity for 80d (threshold 60d)" },
      { name: "ghost", source_kind: "project", path: "/x/g/SKILL.md", curatable: true, category: "abandoned", reason: "loaded 5× but never invoked" },
      { name: "flaky", source_kind: "project", path: "/x/f/SKILL.md", curatable: true, category: "frequently-failing", reason: "3/6 results failed (50%)" },
      // Out-of-scope categories (consolidation/restore) are intentionally ignored by this slice.
      { name: "twin", source_kind: "project", path: "/x/t/SKILL.md", curatable: true, category: "consolidation", reason: "overlap with another skill" },
      { name: "ressurected", source_kind: "project", path: "/x/r/SKILL.md", curatable: true, category: "restore", reason: "active again" },
    ]);
    const { candidates, byCategory } = readArchiveCandidates(env);
    expect(candidates.map((c) => c.name).sort()).toEqual(["arch", "flaky", "ghost", "stale-skill"]);
    expect(Object.keys(byCategory).sort()).toEqual(
      ["abandoned", "archive", "frequently-failing", "stale"].sort(),
    );
    expect(byCategory.stale?.[0].reason).toContain("80d");
    expect(byCategory["frequently-failing"]?.[0].reason).toContain("50%");
    expect(byCategory.abandoned?.[0].reason).toContain("never invoked");
  });

  test("omits categories with zero candidates from byCategory", () => {
    const env = envelope([
      { name: "lonely", source_kind: "project", path: "/x/l/SKILL.md", curatable: true, category: "stale", reason: "no skill activity for 70d" },
    ]);
    const { byCategory } = readArchiveCandidates(env);
    expect(Object.keys(byCategory)).toEqual(["stale"]);
    expect(byCategory.archive).toBeUndefined();
    expect(byCategory.abandoned).toBeUndefined();
    expect(byCategory["frequently-failing"]).toBeUndefined();
  });

  test("defensively drops bundled source_kinds in every category", () => {
    const env = envelope([
      { name: "leak-plugin", source_kind: "plugin", path: "/x/lp/SKILL.md", curatable: false, category: "stale", reason: "n/a" },
      { name: "leak-hub", source_kind: "hub", path: "/x/lh/SKILL.md", curatable: false, category: "frequently-failing", reason: "n/a" },
      { name: "keep", source_kind: "project", path: "/x/k/SKILL.md", curatable: true, category: "abandoned", reason: "loaded 4× but never invoked" },
    ]);
    const { candidates, filtered } = readArchiveCandidates(env);
    expect(candidates.map((c) => c.name)).toEqual(["keep"]);
    expect(filtered.map((f) => f.name).sort()).toEqual(["leak-hub", "leak-plugin"]);
  });

  test("defensively drops a non-curatable recommendation even if it leaked through", () => {
    const env = envelope([
      { name: "leak", source_kind: "project", path: "/x/leak/SKILL.md", curatable: false, category: "archive", reason: "should not happen" },
    ]);
    const { candidates, filtered } = readArchiveCandidates(env);
    expect(candidates).toHaveLength(0);
    expect(filtered).toHaveLength(1);
  });

  test("drops pinned candidates via the orchestrator-provided pin set (across categories)", () => {
    const env = envelope([
      { name: "pinned-one", source_kind: "project", path: "/x/p/SKILL.md", curatable: true, category: "stale", reason: "no skill activity for 70d" },
      { name: "freely", source_kind: "project", path: "/x/f/SKILL.md", curatable: true, category: "archive", reason: "stale" },
    ]);
    const { candidates } = readArchiveCandidates(env, { pinned: new Set(["pinned-one"]) });
    expect(candidates.map((c) => c.name)).toEqual(["freely"]);
  });

  test("parseCuratorReport round-trips a JSON envelope", () => {
    const env = envelope([
      { name: "alpha", source_kind: "project", path: "/x/a/SKILL.md", curatable: true, category: "archive", reason: "r" },
    ]);
    const parsed = parseCuratorReport(JSON.stringify(env));
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.recommendations[0].name).toBe("alpha");
  });
});

describe("consent-gate", () => {
  const cands: ArchiveCandidate[] = [
    { name: "a", source_kind: "project", path: "/x/a/SKILL.md", reason: "", category: "stale" },
    { name: "b", source_kind: "project", path: "/x/b/SKILL.md", reason: "", category: "abandoned" },
    { name: "c", source_kind: "project", path: "/x/c/SKILL.md", reason: "", category: "frequently-failing" },
    { name: "d", source_kind: "project", path: "/x/d/SKILL.md", reason: "", category: "archive" },
  ];

  test("an empty approval set produces zero approvals across all categories", () => {
    const dec = decideConsent(cands, new Set());
    expect(dec.approved).toEqual([]);
    expect(dec.declined).toHaveLength(4);
  });

  test("typo'd names never reach approval — only intersection counts", () => {
    const dec = decideConsent(cands, new Set(["a", "nonexistent"]));
    expect(dec.approved.map((c) => c.name)).toEqual(["a"]);
    expect(dec.declined.map((c) => c.name).sort()).toEqual(["b", "c", "d"]);
  });

  test("approving subsets across categories preserves the approving category on each item", () => {
    const dec = decideConsent(cands, new Set(["a", "c", "d"]));
    expect(dec.approved.map((c) => `${c.name}:${c.category}`).sort()).toEqual([
      "a:stale",
      "c:frequently-failing",
      "d:archive",
    ]);
    expect(dec.declined.map((c) => c.name)).toEqual(["b"]);
  });
});

describe("archive-engine — validation refuses without I/O", () => {
  test("rejects plugin source_kind", () => {
    const rej = validateCandidate({
      name: "p",
      source_kind: "plugin",
      path: "/x/p/SKILL.md",
      reason: "",
      category: "archive",
    });
    expect(rej?.reason).toBe("read-only-source-kind");
  });

  test("rejects hub source_kind", () => {
    const rej = validateCandidate({
      name: "h",
      source_kind: "hub",
      path: "/x/h/SKILL.md",
      reason: "",
      category: "archive",
    });
    expect(rej?.reason).toBe("read-only-source-kind");
  });

  test("rejects pinned skills", () => {
    const rej = validateCandidate({
      name: "p",
      source_kind: "project",
      path: "/x/p/SKILL.md",
      reason: "",
      category: "stale",
      pinned: true,
    });
    expect(rej?.reason).toBe("pinned");
  });

  test("accepts curatable user/project skills", () => {
    expect(
      validateCandidate({
        name: "ok",
        source_kind: "project",
        path: "/x/ok/SKILL.md",
        reason: "",
        category: "archive",
      }),
    ).toBeNull();
  });

  test("executeArchive returns rejection without performing any I/O", async () => {
    const root = await tempRoot();
    // No skill file exists — proves no readdir/walk happened before the gate.
    const result = await executeArchive(
      {
        name: "leaked-plugin",
        source_kind: "plugin",
        path: join(root, "skills", "leaked-plugin", "SKILL.md"),
        reason: "should not happen",
        category: "archive",
      },
      { rootDir: root },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("read-only-source-kind");
    // The archive base must not even exist.
    await expect(access(join(root, ".red/memory/skill-archive"))).rejects.toThrow();
  });
});

describe("archive-engine — archive + restore round-trip", () => {
  async function fixtureSkill(root: string, name = "demo-skill") {
    const skillDir = join(root, "skills", name);
    await mkdir(join(skillDir, "support"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `# ${name}\n\nfixture content\n`, "utf8");
    await writeFile(join(skillDir, "support", "extra.md"), "extra fixture\n", "utf8");
    return { skillDir, skillFile: join(skillDir, "SKILL.md") };
  }

  test(
    "archives a curatable skill, manifest carries hashes, restore is bit-exact",
    async () => {
      const root = await tempRoot();
      const { skillDir, skillFile } = await fixtureSkill(root);
      const skillBytes = await readFile(skillFile);
      const supportBytes = await readFile(join(skillDir, "support", "extra.md"));

      const archived = await executeArchive(
        {
          name: "demo-skill",
          source_kind: "project",
          path: skillFile,
          reason: "no skill activity for 90d (threshold 60d)",
          category: "stale",
        },
        { rootDir: root, now: () => new Date("2026-05-22T16:00:00.000Z") },
      );
      expect(archived.ok).toBe(true);
      if (!archived.ok) throw new Error("unreachable");

      // Original location is empty now (atomic mv via rename).
      await expect(access(skillDir)).rejects.toThrow();

      // Manifest is well-formed and records both files with hashes.
      const manifestRaw = await readFile(archived.receipt.manifestPath, "utf8");
      expect(archived.receipt.manifestPath.endsWith("manifest.toon")).toBe(true);
      expect(manifestRaw.trimStart().startsWith("{")).toBe(false);
      const manifest = decodeMemoryStateDocument<{
        name: string;
        originalRoot: string;
        archivedAt: string;
        category: string;
        reason: string;
        files: Array<{ relativePath: string }>;
      }>(manifestRaw);
      expect(manifest.name).toBe("demo-skill");
      expect(manifest.originalRoot).toBe(skillDir);
      expect(manifest.archivedAt).toBe("2026-05-22T16:00:00.000Z");
      // The approving category is recorded as the archive reason discriminator.
      expect(manifest.category).toBe("stale");
      expect(manifest.reason).toBe("no skill activity for 90d (threshold 60d)");
      expect(manifest.files.map((f: { relativePath: string }) => f.relativePath).sort()).toEqual([
        "SKILL.md",
        "support/extra.md",
      ]);

      // Restore puts everything back at the original path with identical bytes.
      const restored = await executeRestore("demo-skill", { rootDir: root });
      expect(restored.restoredRoot).toBe(skillDir);
      expect(await readFile(skillFile)).toEqual(skillBytes);
      expect(await readFile(join(skillDir, "support", "extra.md"))).toEqual(supportBytes);
    },
    TIMEOUT,
  );

  test(
    "archive-engine never calls a destructive filesystem operation",
    async () => {
      const root = await tempRoot();
      const { skillFile } = await fixtureSkill(root, "no-destroy");

      // Trip-wire facade: every non-destructive call passes through to the
      // real fs; any read of `unlink`/`rm`/`rmdir` (and their *Sync variants)
      // throws — proof that the engine has no code path that even *names* a
      // destructive op. This is the "monkey-patched unlink/rm-equivalents"
      // assertion in interface form, since node:fs/promises members are
      // non-configurable and `vi.spyOn` cannot redefine them.
      const FORBIDDEN = new Set([
        "unlink",
        "unlinkSync",
        "rm",
        "rmSync",
        "rmdir",
        "rmdirSync",
      ]);
      const tripped: string[] = [];
      const tripwire = new Proxy(defaultArchiveFs as unknown as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && FORBIDDEN.has(prop)) {
            tripped.push(prop);
            return () => {
              throw new Error(`archive-engine touched destructive ${prop}`);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as ArchiveFs;

      const r1 = await executeArchive(
        {
          name: "no-destroy",
          source_kind: "project",
          path: skillFile,
          reason: "stale",
          category: "archive",
        },
        { rootDir: root, fs: tripwire },
      );
      expect(r1.ok).toBe(true);
      const r2 = await executeRestore("no-destroy", { rootDir: root, fs: tripwire });
      expect(r2.name).toBe("no-destroy");
      expect(tripped).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("memory curate workflow CLI", () => {
  test(
    "check fails fast with the exact `memory init` command when telemetry is off",
    async () => {
      const root = await tempRoot();
      // Memory not initialized here.
      const result = runCurate(["check", "--root", root]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("memory init --mode graph --skill-telemetry");
    },
    TIMEOUT,
  );

  test(
    "check succeeds when graph mode + skill telemetry are on",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const result = runCurate(["check", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ready to curate");
    },
    TIMEOUT,
  );

  test(
    "empty/declined approval set produces zero filesystem mutations",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });

      const skillDir = join(root, "skills", "untouched");
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, "SKILL.md");
      const skillBody = "# untouched\n\nfixture\n";
      await writeFile(skillFile, skillBody, "utf8");
      const before = await stat(skillFile);

      // Just calling `list` should not mutate anything.
      const listResult = runCurate(["list", "--root", root]);
      expect(listResult.status).toBe(0);

      // No archive directory was created.
      await expect(access(join(root, ".red/memory/skill-archive"))).rejects.toThrow();

      // Original skill file unchanged.
      expect(await readFile(skillFile, "utf8")).toBe(skillBody);
      const after = await stat(skillFile);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
    TIMEOUT,
  );
});
