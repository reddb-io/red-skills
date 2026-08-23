import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import {
  redskilledStableBundleDir,
  redskilledStableBundleName,
  redskilledStatuslineBundleName,
  stabilizeRedskilledEntry,
} from "@reddb-io/redskilled/stable-bundle";
import { REDSKILLED_RENDER_ABSENCE } from "@reddb-io/redskilled-render";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  STATUSLINE_COMMAND_ABSENCE,
  STATUSLINE_COMMAND_DOCS,
  STATUSLINE_COMMAND_TERMINATOR,
  describeStatuslineAbsence,
  describeStatuslineDelegation,
  describeStatuslineDrift,
  describeStatuslineTermination,
  driftedStatuslineCommands,
  findStatuslineCommands,
  readStatuslineCommands,
  statuslineBundleGlobs,
  statuslineCommandsDelegatingWorkers,
  statuslineCommandsMissingAbsence,
  statuslineGlobResolves,
  unterminatedStatuslineCommands,
} from "../src/core/statusline-command-doc.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The version a provisioned host would have filed. Any pin works — it is keyed, not parsed. */
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

/** A fake HOME holding one daemon bundle that prints a line. */
function hostWithLeanAndDaemonBundles(leanLine: string, daemonLine: string): string {
  const home = hostWithDaemonBundleOnly(daemonLine);
  writeFileSync(
    join(redskilledStableBundleDir(home), redskilledStatuslineBundleName("1.0.0")),
    `console.log(${JSON.stringify(leanLine)});\n`,
  );
  return home;
}

function hostWithDaemonBundleOnly(line: string): string {
  const home = scratchHome();
  const bundles = redskilledStableBundleDir(home);
  mkdirSync(bundles, { recursive: true });
  writeFileSync(
    join(bundles, redskilledStableBundleName("1.0.0")),
    `console.log(${JSON.stringify(line)});\n`,
  );
  return home;
}

/** A fake HOME with no cached bundle and no plugin cache — nothing can render. */
function hostWithNoRenderer(): string {
  return scratchHome();
}

/**
 * A HOME provisioned the way a real one is: by running the SAME
 * `stabilizeRedskilledEntry` every unit writer runs before it points an
 * `ExecStart` at a bundle. Only the resolved source is faked — the directory,
 * the filename and the version attribution are the daemon's own, which is the
 * whole point: this is the render command's view of provisioning, not a
 * restatement of it.
 */
function provisionedHost(line: string): string {
  const home = scratchHome();
  // ADR 0130 Amendment 2: the home has two creators and stabilization is not
  // one of them, so a test that wants the copy must place the home first.
  mkdirSync(redskilledHomeDir(home), { recursive: true, mode: 0o700 });
  const resolved = join(home, "npx-cache", "redskilled.bundle.min.mjs");
  mkdirSync(join(home, "npx-cache"), { recursive: true });
  writeFileSync(resolved, `console.log(${JSON.stringify(line)});\n`);

  const stabilized = stabilizeRedskilledEntry(
    { command: "node", args: [resolved], entry: resolved },
    { version: PROVISIONED_VERSION, homeDir: home },
  );
  expect(stabilized.entry, "the daemon did not file a stable copy").toBe(
    join(redskilledStableBundleDir(home), redskilledStableBundleName(PROVISIONED_VERSION)),
  );
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
  // An isolated cwd: the command writes the project's `.red/state/statusline/`
  // lane (the native front's cache), and a test must never write the REPO's.
  const cwd = mkdtempSync(join(tmpdir(), "red-skills-statusline-cwd-"));
  scratch.push(cwd);
  return spawnSync("sh", ["-c", shellBody(canonical!.body)], {
    cwd,
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
    expect(findStatuslineCommands("fixture.md", '"command": "pnpm -C apps/plugin-dev test",')).toEqual([]);
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

  it("runs in every gate run — the published copies live outside apps/plugin-dev", () => {
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

  it("prints the header and exits 0 on a host holding one daemon bundle", () => {
    const run = renderStatusline(hostWithDaemonBundleOnly("» fixture (main) Opus"));

    expect(run.stdout).toContain("» fixture (main) Opus");
    expect(run.status, run.stderr).toBe(0);
  });

  it("prefers the native front, and refreshes the lane in the background (ADR 0157)", () => {
    const home = hostWithLeanAndDaemonBundles("lean renderer spoke", "daemon bundle spoke");
    const binDir = join(redskilledHomeDir(home), "bin");
    mkdirSync(binDir, { recursive: true });
    const front = join(binDir, "statusline-fast");
    writeFileSync(front, "#!/bin/sh\necho native front spoke\n", { mode: 0o755 });

    const run = renderStatusline(home);

    expect(run.stdout).toContain("native front spoke");
    // The renderer still runs — in the BACKGROUND, into the project lane —
    // so the foreground never carries its output.
    expect(run.stdout).not.toContain("lean renderer spoke");
    expect(run.status, run.stderr).toBe(0);
  });

  it("prefers the lean renderer over the daemon bundle when both are stabilized", () => {
    const run = renderStatusline(
      hostWithLeanAndDaemonBundles("lean renderer spoke", "daemon bundle spoke"),
    );

    expect(run.stdout).toContain("lean renderer spoke");
    expect(run.stdout).not.toContain("daemon bundle spoke");
    expect(run.status, run.stderr).toBe(0);
  });
});

describe("daemon bundle resolution (#3074)", () => {
  it("names every copy that renders an unresolved daemon as nothing", () => {
    const silent = findStatuslineCommands("a.md", `"command": "sh -c 'r=; [ -n \\"$r\\" ] && run; exit 0'"`);

    expect(statuslineCommandsMissingAbsence(silent).map((site) => site.path)).toEqual(["a.md"]);
    expect(describeStatuslineAbsence(silent)).toContain(STATUSLINE_COMMAND_ABSENCE);
  });

  it("lifts the bundle globs out in the order the command tries them", () => {
    const body = 'd=$(ls -1 "$HOME"/.red/redskilled/bundles/redskilled-*.bundle.min.mjs); e=$(ls -1 "$HOME"/.red/redskilled/bundles/redskilled-canary.bundle.min.mjs)';

    expect(statuslineBundleGlobs(body)).toEqual([
      "redskilled-*.bundle.min.mjs",
      "redskilled-canary.bundle.min.mjs",
    ]);
    expect(statuslineGlobResolves(body, "redskilled-9.9.9.bundle.min.mjs")).toBe(true);
    expect(statuslineGlobResolves(body, "memory-9.9.9.bundle.min.mjs")).toBe(false);
  });

  it("reads no glob out of the cache directory the deleted dev runtime lived in", () => {
    expect(statuslineBundleGlobs('b=$(ls -1 "$HOME"/.cache/red-skills/bundles/dev-*.bundle.min.mjs)')).toEqual([]);
  });

  it("says the absence in the daemon's own sentence, never a second spelling", () => {
    expect(STATUSLINE_COMMAND_ABSENCE).toBe(REDSKILLED_RENDER_ABSENCE);
  });

  it("states the absence in every published copy", () => {
    const sites = readStatuslineCommands(REPO_ROOT);

    expect(statuslineCommandsMissingAbsence(sites), describeStatuslineAbsence(sites)).toEqual([]);
  });

  /**
   * The pairing #3074 was missing: the command globbed a directory nothing wrote
   * a bundle to. Asserted against the DAEMON's own namers rather than a literal,
   * so renaming the stable directory or the stable filename fails HERE.
   */
  it("globs the name and the directory daemon provisioning actually writes", () => {
    const [canonical] = readStatuslineCommands(REPO_ROOT);
    const body = shellBody(canonical!.body);

    const minted = redskilledStableBundleName(PROVISIONED_VERSION);
    expect(
      statuslineGlobResolves(body, minted),
      `no published glob resolves ${minted} — globs: ${statuslineBundleGlobs(body).join(", ")}`,
    ).toBe(true);
    // The lean renderer the daemon stabilizes beside its own bundle resolves
    // too, and it is tried FIRST: a per-render invocation must not pay the
    // daemon bundle's import-time initialization when the lean copy exists.
    const leanMinted = redskilledStatuslineBundleName(PROVISIONED_VERSION);
    expect(
      statuslineGlobResolves(body, leanMinted),
      `no published glob resolves ${leanMinted} — globs: ${statuslineBundleGlobs(body).join(", ")}`,
    ).toBe(true);
    const globs = statuslineBundleGlobs(body);
    expect(globs.indexOf("statusline-*.bundle.min.mjs")).toBeLessThan(
      globs.indexOf("redskilled-*.bundle.min.mjs"),
    );
    // And the daemon's own glob never swallows the lean renderer: the sort -V
    // tail of `redskilled-*` must keep resolving the DAEMON bundle.
    const daemonHalf = 'd=$(ls -1 "$HOME"/.red/redskilled/bundles/redskilled-*.bundle.min.mjs)';
    expect(statuslineGlobResolves(daemonHalf, leanMinted)).toBe(false);
    // `""` yields the segments below the operator home, which is exactly the
    // part the shell spells after its own `"$HOME"`.
    expect(body).toContain(`${redskilledStableBundleDir("")}/redskilled-`);
  });

  it("states the absence when no renderer resolves at all", () => {
    const run = renderStatusline(hostWithNoRenderer());

    expect(run.stdout).toContain(REDSKILLED_RENDER_ABSENCE);
    expect(run.status, run.stderr).toBe(0);
  });
});

/**
 * The host invokes one producer, and it is a LIVE one. The redskilled bundle
 * draws the bedrock and the Worker tail in one process, so `--no-workers` is a
 * fossil of the retired split (#3559) and any reach for the dev runtime is a
 * fossil of a renderer ADR 0147 deleted.
 */
describe("one statusline host producer (#3559)", () => {
  it("names every copy that carries the retired split flag", () => {
    const muted = findStatuslineCommands("a.md", `"command": "sh -c '\\"$N\\" \\"$b\\" statusline --no-workers; exit 0'"`);

    expect(statuslineCommandsDelegatingWorkers(muted).map((site) => site.path)).toEqual(["a.md"]);
    expect(describeStatuslineDelegation(muted)).toContain("retired statusline producer");
  });

  it("names every copy that reaches for the dev bundle ADR 0147 deleted", () => {
    const fossil = findStatuslineCommands(
      "a.md",
      `"command": "sh -c 'b=$(ls -1 \\"$HOME\\"/.cache/red-skills/bundles/dev-*.bundle.min.mjs); exit 0'"`,
    );

    expect(statuslineCommandsDelegatingWorkers(fossil).map((site) => site.path)).toEqual(["a.md"]);
  });

  it("names every copy that reaches for the launcher behind that bundle", () => {
    const fossil = findStatuslineCommands(
      "a.md",
      `"command": "sh -c 'b=$(ls -1 \\"$HOME\\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs); exit 0'"`,
    );

    expect(statuslineCommandsDelegatingWorkers(fossil).map((site) => site.path)).toEqual(["a.md"]);
  });

  it("passes the daemon bundle the command actually runs", () => {
    const live = findStatuslineCommands(
      "a.md",
      `"command": "sh -c 'd=$(ls -1 \\"$HOME\\"/.red/redskilled/bundles/redskilled-*.bundle.min.mjs); exit 0'"`,
    );

    expect(statuslineCommandsDelegatingWorkers(live)).toEqual([]);
  });

  it("passes a command that draws the Worker rows from one bundle", () => {
    const single = findStatuslineCommands("a.md", `"command": "sh -c '\\"$N\\" \\"$b\\" statusline; exit 0'"`);

    expect(statuslineCommandsDelegatingWorkers(single)).toEqual([]);
    expect(describeStatuslineDelegation(single)).toBe("");
  });

  it("keeps every published copy on one producer", () => {
    const sites = readStatuslineCommands(REPO_ROOT);

    expect(statuslineCommandsDelegatingWorkers(sites), describeStatuslineDelegation(sites)).toEqual([]);
  });

  it("renders through one producer on a freshly provisioned host", () => {
    const run = renderStatusline(provisionedHost("» fixture (main) Opus"));

    expect(run.stdout).toContain("» fixture (main) Opus");
    expect(run.stdout).not.toContain(STATUSLINE_COMMAND_ABSENCE);
    expect(run.status, run.stderr).toBe(0);
  });

  it("ignores a dev bundle still sitting on the machine", () => {
    const home = provisionedHost("» fixture (main) Opus");
    const stale = join(home, ".cache", "red-skills", "bundles");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "dev-3.21.0.bundle.min.mjs"), 'console.log("frozen at 3.21.0");\n');

    const run = renderStatusline(home);

    expect(run.stdout, "the deleted dev runtime is resolvable again").not.toContain("frozen at 3.21.0");
    expect(run.stdout).toContain("» fixture (main) Opus");
  });

  it("tells the reader to keep the bedrock and daemon tail behind one command", () => {
    const muted = findStatuslineCommands("a.md", `"command": "sh -c 'statusline --no-workers; exit 0'"`);
    const message = describeStatuslineDelegation(muted);

    expect(message).toContain("renders the local bedrock");
    expect(message).toContain("the Worker tail in one process");
    expect(message).toContain("a.md:1");
  });
});

describe("statusline architecture documentation (#3559)", () => {
  it("describes the dev bundle as the one host producer with a local bedrock and daemon tail", () => {
    const hostNotes = readFileSync(
      join(REPO_ROOT, "plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md"),
      "utf8",
    );
    const skill = readFileSync(
      join(REPO_ROOT, "plugins/dev/skills/engineering/red-statusline/SKILL.md"),
      "utf8",
    );

    expect(hostNotes).toContain("renders the local bedrock before appending the daemon-fed tail");
    expect(hostNotes).toContain("~/.red/redskilled/bundles/");
    expect(hostNotes).not.toContain("calls `collectStatuslineAfk`");
    expect(hostNotes).not.toContain("INTERIM, until #3151");
    expect(skill).toContain("one bounded local socket read");
    expect(skill).not.toContain("a direct collector client (ADR 0084)");
  });
});
