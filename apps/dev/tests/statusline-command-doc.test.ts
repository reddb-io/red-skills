import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  STATUSLINE_COMMAND_DOCS,
  STATUSLINE_COMMAND_TERMINATOR,
  describeStatuslineDrift,
  describeStatuslineTermination,
  driftedStatuslineCommands,
  findStatuslineCommands,
  readStatuslineCommands,
  unterminatedStatuslineCommands,
} from "../src/core/statusline-command-doc.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fake HOME holding a dev bundle that prints a header and NO daemon bundle. */
function hostWithoutDaemonBundle(header: string): string {
  const home = mkdtempSync(join(tmpdir(), "red-skills-statusline-"));
  scratch.push(home);
  const bundles = join(home, ".cache", "red-skills", "bundles");
  mkdirSync(bundles, { recursive: true });
  writeFileSync(join(bundles, "dev-1.0.0.bundle.min.mjs"), `console.log(${JSON.stringify(header)});\n`);
  return home;
}

/** The shell text the doc publishes, with its JSON escapes resolved. */
function shellBody(escaped: string): string {
  return JSON.parse(`"${escaped}"`) as string;
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
    const [canonical] = readStatuslineCommands(REPO_ROOT);
    expect(canonical).toBeDefined();

    const home = hostWithoutDaemonBundle("» fixture (main) Opus");
    const run = spawnSync("sh", ["-c", shellBody(canonical!.body)], {
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      input: `{"workspace":{"project_dir":"${REPO_ROOT}"},"model":{"display_name":"Opus"}}`,
      encoding: "utf8",
    });

    expect(run.stdout).toContain("» fixture (main) Opus");
    expect(run.status, run.stderr).toBe(0);
  });
});
