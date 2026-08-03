import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type BundleIO,
  bundleFileName,
  companionBundlePlugins,
  ensureBundle,
  packagedBundleRelPath,
} from "@reddb-io/shared/bundle-fetch.js";
import { REDSKILLED_STATUSLINE_ABSENCE } from "@reddb-io/redskilled/statusline-render";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  STATUSLINE_COMMAND_ABSENCE,
  STATUSLINE_COMMAND_DOCS,
  STATUSLINE_COMMAND_TERMINATOR,
  describeStatuslineAbsence,
  describeStatuslineDrift,
  describeStatuslineTermination,
  driftedStatuslineCommands,
  findStatuslineCommands,
  readStatuslineCommands,
  statuslineBundleGlobs,
  statuslineCommandsMissingAbsence,
  statuslineGlobResolves,
  unterminatedStatuslineCommands,
} from "../src/core/statusline-command-doc.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The version a provisioned host would have warmed. Any pin works — it is keyed, not parsed. */
const PROVISIONED_VERSION = "9.9.9";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "red-skills-statusline-"));
  scratch.push(home);
  return home;
}

/** A fake HOME holding a dev bundle that prints a header and NO daemon bundle. */
function hostWithoutDaemonBundle(header: string): string {
  const home = scratchHome();
  const bundles = join(home, ".cache", "red-skills", "bundles");
  mkdirSync(bundles, { recursive: true });
  writeFileSync(join(bundles, "dev-1.0.0.bundle.min.mjs"), `console.log(${JSON.stringify(header)});\n`);
  return home;
}

/**
 * A HOME provisioned the way a real one is: by running the SAME `ensureBundle`
 * the `SessionStart` warm hook runs, against a fake npm package. Only npm is
 * faked — the cache layout, the filenames and the companion set are the real
 * ones, which is the whole point: this is the render command's view of
 * provisioning, not a restatement of it.
 */
async function provisionedHost(bundleSource: (plugin: string) => string): Promise<string> {
  const home = scratchHome();
  const io: BundleIO = {
    async materialize(_spec, stagingDir) {
      const root = join(stagingDir, "node_modules", "@reddb-io", "red-skills");
      for (const plugin of ["dev", ...companionBundlePlugins("dev")]) {
        const file = join(root, packagedBundleRelPath(plugin));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bundleSource(plugin));
      }
      return root;
    },
    async readFile(path) {
      return new Uint8Array(readFileSync(path));
    },
    async writeFile(path, bytes) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
    async exists(path) {
      return existsSync(path);
    },
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    async fetchText() {
      throw new Error("the render path does no network work (ADR 0084)");
    },
  };
  await ensureBundle(io, {
    plugin: "dev",
    version: PROVISIONED_VERSION,
    cacheDir: join(home, ".cache", "red-skills", "bundles"),
  });
  return home;
}

/** The shell text the doc publishes, with its JSON escapes resolved. */
function shellBody(escaped: string): string {
  return JSON.parse(`"${escaped}"`) as string;
}

/** Run the published command against a fake HOME, exactly as Claude Code would. */
function renderStatusline(home: string) {
  const [canonical] = readStatuslineCommands(REPO_ROOT);
  expect(canonical).toBeDefined();
  return spawnSync("sh", ["-c", shellBody(canonical!.body)], {
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    input: `{"workspace":{"project_dir":"${REPO_ROOT}"},"model":{"display_name":"Opus"}}`,
    encoding: "utf8",
  });
}

describe("documented statusLine command (#3073)", () => {
  it("locates the published command field", () => {
    const sites = findStatuslineCommands(
      "fixture.md",
      ['  "statusLine": {', '    "type": "command",', `    "command": "sh -c 'echo hi${STATUSLINE_COMMAND_TERMINATOR}'",`, "  }"].join("\n"),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ line: 3, body: `echo hi${STATUSLINE_COMMAND_TERMINATOR}` });
  });

  it("ignores an unrelated command field", () => {
    expect(findStatuslineCommands("fixture.md", '"command": "pnpm -C apps/dev test",')).toEqual([]);
  });

  it("names every copy that drifted from the first", () => {
    const sites = [
      ...findStatuslineCommands("a.md", `"command": "sh -c 'echo a${STATUSLINE_COMMAND_TERMINATOR}'"`),
      ...findStatuslineCommands("b.md", `"command": "sh -c 'echo b${STATUSLINE_COMMAND_TERMINATOR}'"`),
    ];

    expect(driftedStatuslineCommands(sites).map((site) => site.path)).toEqual(["b.md"]);
    expect(describeStatuslineDrift(sites)).toContain("b.md:1");
  });

  it("names every copy that can still exit non-zero", () => {
    const sites = findStatuslineCommands("a.md", `"command": "sh -c '[ -n \\"$r\\" ] && run'"`);

    expect(unterminatedStatuslineCommands(sites).map((site) => site.path)).toEqual(["a.md"]);
    expect(describeStatuslineTermination(sites)).toContain(STATUSLINE_COMMAND_TERMINATOR);
  });

  it("sweeps both hand-maintained docs and both generated mirrors", () => {
    expect(STATUSLINE_COMMAND_DOCS).toContain("plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md");
    expect(STATUSLINE_COMMAND_DOCS).toContain("plugins/dev/skills/engineering/red-setup/INTERVIEW.md");
    expect(STATUSLINE_COMMAND_DOCS).toContain("packaging/pi/dev/skills/engineering/red-statusline/HOST-NOTES.md");
    expect(STATUSLINE_COMMAND_DOCS).toContain("packaging/pi/dev/skills/engineering/red-setup/INTERVIEW.md");
  });

  it("runs in every gate run — the published copies live outside apps/dev", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain("invariants:statusline-command");
  });

  it("publishes exactly one copy per declared doc", () => {
    for (const doc of STATUSLINE_COMMAND_DOCS) {
      expect(readStatuslineCommands(REPO_ROOT, [doc]), doc).toHaveLength(1);
    }
  });

  it("keeps every published copy byte-identical", () => {
    const sites = readStatuslineCommands(REPO_ROOT);

    expect(driftedStatuslineCommands(sites), describeStatuslineDrift(sites)).toEqual([]);
  });

  it("terminates every published copy in an explicit success", () => {
    const sites = readStatuslineCommands(REPO_ROOT);

    expect(unterminatedStatuslineCommands(sites), describeStatuslineTermination(sites)).toEqual([]);
  });

  it("prints the header and exits 0 on a host with no cached daemon bundle", () => {
    const run = renderStatusline(hostWithoutDaemonBundle("» fixture (main) Opus"));

    expect(run.stdout).toContain("» fixture (main) Opus");
    expect(run.status, run.stderr).toBe(0);
  });
});

describe("daemon bundle resolution (#3074)", () => {
  it("names every copy that renders an unresolved daemon as nothing", () => {
    const silent = findStatuslineCommands("a.md", `"command": "sh -c 'r=; [ -n \\"$r\\" ] && run; exit 0'"`);

    expect(statuslineCommandsMissingAbsence(silent).map((site) => site.path)).toEqual(["a.md"]);
    expect(describeStatuslineAbsence(silent)).toContain(STATUSLINE_COMMAND_ABSENCE);
  });

  it("lifts the bundle-cache globs out in the order the command tries them", () => {
    const body = 'b=$(ls -1 "$HOME"/.cache/red-skills/bundles/dev-*.bundle.min.mjs); r=$(ls -1 "$HOME"/.cache/red-skills/bundles/redskilled*.bundle.min.mjs)';

    expect(statuslineBundleGlobs(body)).toEqual(["dev-*.bundle.min.mjs", "redskilled*.bundle.min.mjs"]);
    expect(statuslineGlobResolves(body, "redskilled-9.9.9.bundle.min.mjs")).toBe(true);
    expect(statuslineGlobResolves(body, "memory-9.9.9.bundle.min.mjs")).toBe(false);
  });

  it("says the absence in the daemon's own sentence, never a second spelling", () => {
    expect(STATUSLINE_COMMAND_ABSENCE).toBe(REDSKILLED_STATUSLINE_ABSENCE);
  });

  it("states the absence in every published copy", () => {
    const sites = readStatuslineCommands(REPO_ROOT);

    expect(statuslineCommandsMissingAbsence(sites), describeStatuslineAbsence(sites)).toEqual([]);
  });

  /**
   * The pairing #3074 was missing: the command globbed a directory nothing wrote
   * a `redskilled` bundle to. Asserted against the filename the warm path mints
   * rather than a literal, so renaming the cache key fails HERE.
   */
  it("globs a name the dev warm path actually writes, for every warmed bundle", () => {
    const [canonical] = readStatuslineCommands(REPO_ROOT);
    const body = shellBody(canonical!.body);

    expect(companionBundlePlugins("dev")).toContain("redskilled");
    for (const plugin of ["dev", "redskilled"]) {
      const warmed = bundleFileName(plugin, PROVISIONED_VERSION);
      expect(
        statuslineGlobResolves(body, warmed),
        `no published glob resolves ${warmed} — globs: ${statuslineBundleGlobs(body).join(", ")}`,
      ).toBe(true);
    }
  });

  it("reaches the daemon on a freshly provisioned host", async () => {
    const home = await provisionedHost((plugin) =>
      plugin === "dev"
        ? 'console.log("» fixture (main) Opus");\n'
        : `console.log(${JSON.stringify(`${plugin} rows`)});\n`,
    );

    const run = renderStatusline(home);

    expect(run.stdout).toContain("» fixture (main) Opus");
    expect(run.stdout, "the daemon half was never contacted (#3074)").toContain("redskilled rows");
    expect(run.stdout).not.toContain(STATUSLINE_COMMAND_ABSENCE);
    expect(run.status, run.stderr).toBe(0);
  });

  it("states the absence when no daemon bundle resolves at all", () => {
    const run = renderStatusline(hostWithoutDaemonBundle("» fixture (main) Opus"));

    expect(run.stdout).toContain("» fixture (main) Opus");
    expect(run.stdout).toContain(REDSKILLED_STATUSLINE_ABSENCE);
    expect(run.status, run.stderr).toBe(0);
  });
});
