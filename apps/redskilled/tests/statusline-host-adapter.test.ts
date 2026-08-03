// ONE producer draws the Worker rows, and the recipe is pinned HERE — in the
// package that owns the daemon's string — by reading the shipped documents
// rather than by anyone remembering to look (#2928).
//
// **Which producer, and why not the daemon yet (#3166).** Rule 10 says the
// daemon owns the Worker line, and #2928 wired the recipe to it: the dev bundle
// was asked for the header alone with `--no-workers` and the daemon's own
// `statusline` was echoed under it. That delegation was made before the thing
// delegated to could draw. What the operator actually got was a name and a
// memory figure where the dev bundle had been drawing a bar, a colour, aligned
// `run=`/`org=`/`iss=` columns, `phase·activity`, elapsed, heartbeat, diff and
// token vitals — code already in the tree and already tested. So the recipe is
// reversed to the single-producer form until #3151 rewrites the daemon's `line`
// density to carry that row.
//
// What did NOT change is the count: two renderers on screen is the defect #2928
// named, and the test below still refuses it — from the other side. The recipe
// may not run the daemon half (a second block of rows under the first) and may
// not mute the dev bundle (no rows at all). Restoring the delegation is one edit
// here plus one in `statusline-command-doc.ts`, and #3151 is what earns it.
//
// The second half is the claim rule 10 rests on: what the daemon's own command
// prints is byte-for-byte what the daemon handed it. Not "contains the Worker
// ids", not "looks right" — the same string, compared. That contract is live
// today, for every surface that reads the daemon; only the Claude Code statusLine
// recipe is on the interim detour.
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

  it("asks exactly one producer for the Worker rows — the dev bundle, until #3151", () => {
    const offenders: string[] = [];
    for (const recipe of shippedAdapterRecipes()) {
      for (const command of recipe.commands) {
        // The daemon's own bundle under the dev bundle's rows is a second block
        // of Workers on screen, saying less than the block above it.
        if (/redskilled[\w.*-]*\.bundle\.min\.mjs/.test(command)) {
          offenders.push(`${recipe.path}: runs the daemon renderer under the dev bundle's rows — double-render until #3151 lands`);
        }
        // `--no-workers` mutes the only producer left, and nothing draws a row.
        if (/dev-\*\.bundle\.min\.mjs|afk\.mjs/.test(command) && command.includes("--no-workers")) {
          offenders.push(`${recipe.path}: mutes the dev bundle's Worker rows with nothing left to draw them (#3166)`);
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
    expect(served.lines.length).toBe(5);
    expect(written[0]).toContain("w-1 is doing something");
    expect(written[0]).toContain("w-2 is doing something");
  });
});
