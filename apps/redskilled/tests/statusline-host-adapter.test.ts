// The agent host DISPLAYS the Worker line; it does not produce one (#2928).
//
// The daemon serving a finished string (ADR 0130 rule 10) buys nothing while the
// installed adapter keeps rendering its own: what an operator reads is whatever
// their `.claude/settings.json` runs, and before this test that command resolved
// the dev bundle and formatted Workers inside it — the second renderer rule 10
// exists to prevent, and the one actually on screen. So the recipe is pinned
// HERE, in the package that owns the string, and pinned by reading the shipped
// documents rather than by anyone remembering to look.
//
// The second half is the claim the first one rests on: what the command prints
// is byte-for-byte what the daemon handed it. Not "contains the Worker ids",
// not "looks right" — the same string, compared.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { runStatusline } from "../src/cli.js";
import { readRedskilledStatuslineString } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { resolveRedskilledStatuslineOptions } from "../src/statusline-config.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const MB = 1024 * 1024;

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-statusline-adapter-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Every shipped document that spells out a Claude Code `statusLine` command.
 *
 * Found by SEARCHING rather than by a list, so a fourth copy of the recipe
 * inherits the contract the moment it lands. `packaging/` mirrors are generated
 * from these and are checked through their source.
 */
function shippedAdapterRecipes(): { path: string; commands: string[] }[] {
  const found: { path: string; commands: string[] }[] = [];
  for (const area of ["plugins", "packaging"]) {
    const dir = join(REPO_ROOT, area);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      const rel = `${area}/${entry.split(sep).join("/")}`;
      if (!rel.endsWith(".md")) continue;
      const file = join(REPO_ROOT, rel);
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      // The recipe, not a mention of it: a line that both names `statusLine` and
      // carries a command is a document telling someone what to install.
      const commands = text
        .split("\n")
        .filter((line) => line.includes('"statusLine"') || (line.includes('"command"') && line.includes("statusline")))
        .filter((line) => line.includes("statusline"));
      if (commands.length > 0) found.push({ path: rel, commands });
    }
  }
  return found;
}

describe("the shipped Claude Code adapter", () => {
  it("is documented somewhere, so this contract has something to hold", () => {
    expect(shippedAdapterRecipes().map((recipe) => recipe.path)).not.toEqual([]);
  });

  it("asks the daemon for the Worker rows instead of rendering them", () => {
    const offenders: string[] = [];
    for (const recipe of shippedAdapterRecipes()) {
      for (const command of recipe.commands) {
        // The daemon's own bundle, asked for its own line.
        if (!/redskilled[\w.*-]*\.bundle\.min\.mjs/.test(command)) {
          offenders.push(`${recipe.path}: never reaches redskilled for the Worker rows`);
        }
        // The dev bundle may still produce the repo header — that is its fact —
        // but it must be asked for the header ALONE. An unqualified `statusline`
        // there is the second renderer coming back.
        if (/dev-\*\.bundle\.min\.mjs|afk\.mjs/.test(command) && !command.includes("--no-workers")) {
          offenders.push(`${recipe.path}: asks the dev bundle for a full statusline, Worker rows included`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("what the host prints", () => {
  it("is the string the daemon produced, byte for byte", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: { "w-1": 512 * MB, "w-2": 96 * MB }, cpu_seconds: {} }),
    });
    running.push(daemon);
    for (const [index, id] of ["w-1", "w-2"].entries()) {
      const view: RedskilledWorkerView = {
        worker_id: id,
        project_label: "acme/widgets",
        pid: 4242 + index,
        started_at: "2026-07-29T00:00:00.000Z",
        workspace_path: `/tmp/acme/${id}`,
        isolated: true,
        budget: { memory_max: "1G" },
        warnings: [],
      };
      daemon.trackWorker(view);
      daemon.publishWorkerHeartbeat({ worker_id: id, last_log_line: `${id} is doing something` });
    }
    await daemon.sampleMemoryBudgets();

    const cwd = await scratch("redskilled-statusline-adapter-project-");
    await mkdir(join(cwd, ".red"), { recursive: true });
    await writeFile(
      join(cwd, ".red", "config.yaml"),
      ["project:", "  name: acme/widgets", "plugins:", "  dev:", "    statusline:", "      verbose: true", ""].join("\n"),
      "utf8",
    );

    const written: string[] = [];
    const code = await runStatusline([], { cwd, paths, write: (line) => written.push(line), warn: () => undefined });

    // The same taste the command resolved, asked for again through the client:
    // whatever the host printed has to BE this, with nothing added or reordered.
    const resolved = resolveRedskilledStatuslineOptions({
      configText: readFileSync(join(cwd, ".red", "config.yaml"), "utf8"),
      project: "acme/widgets",
    });
    const served = await readRedskilledStatuslineString(paths, resolved.options, { sessionProject: "acme/widgets" });

    expect(code).toBe(0);
    expect(written).toEqual([`${served.lines.join("\n")}\n`]);
    // `--verbose` is the interesting case: the extra rows carry each Worker's
    // last logged line, published by the Worker and stored opaque by the daemon.
    expect(served.lines.length).toBe(3);
    expect(written[0]).toContain("w-1 is doing something");
    expect(written[0]).toContain("w-2 is doing something");
  });
});
