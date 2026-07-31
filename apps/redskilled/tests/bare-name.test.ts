// The daemon has to be reachable under the name an operator actually reaches
// for. It shipped only as `red-skills-redskilled`, so the shortest route to it
// was `npx -y -p @reddb-io/red-skills@latest red-skills-redskilled host-state`
// — a prefixed name nobody guesses, for a product whose own name is
// `redskilled` (issue #2960).
//
// Two routes are added and NEITHER replaces anything. The bare `redskilled` bin
// is an ERGONOMIC ALIAS: ADR 0091 made the version-pinned `-p <pkg>@<version>`
// form canonical precisely because a bare name resolved off `PATH` can pick up a
// different installation than the one intended (PR #2465), and that stays true.
// The clone launcher is the other half, and it exists for a different reason: an
// operator debugging a broken daemon must not need a working registry fetch to
// run the binary that reports what is broken.
//
// So the checks below are about SAMENESS, not about a new surface. Both names
// must reach the same artifact with the same argv, the prefixed name must keep
// working, and the launcher in the clone must answer the two questions a binary
// owes when nothing else works.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDSKILLED_USAGE } from "../src/cli.js";
import { REDSKILLED_BUNDLE_ASSET } from "../src/client.js";
import { isRedskilledEntryPath } from "../src/daemon-entry.js";

const APP = resolve(__dirname, "..");
const ROOT = resolve(APP, "..", "..");
const PACKAGING = join(ROOT, "packaging", "npm");
const BARE_SHIM = join(PACKAGING, "bin", "redskilled.mjs");
const PREFIXED_SHIM = join(PACKAGING, "bin", "red-skills-redskilled.mjs");
/** The clone-local launcher: no install, no registry, no `dist/` required to find. */
const LAUNCHER = join(ROOT, "bin", "redskilled");

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("redskilled ships under its own name", () => {
  it("declares the bare name and keeps the prefixed one — this adds, it does not rename", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGING, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.redskilled).toBe("bin/redskilled.mjs");
    expect(pkg.bin?.["red-skills-redskilled"]).toBe("bin/red-skills-redskilled.mjs");
  });

  it("points both bins at the one packaged bundle", () => {
    for (const shim of [BARE_SHIM, PREFIXED_SHIM]) {
      expect(existsSync(shim), `${shim} is declared in the bin map but absent`).toBe(true);
      expect(readFileSync(shim, "utf8")).toContain(REDSKILLED_BUNDLE_ASSET);
    }
  });

  it("reaches the same artifact with the same argv under either name", async () => {
    // A copy of the packaged layout, so the shims resolve a bundle we control
    // rather than whatever a local build left in `packaging/npm/dist/`. Both are
    // asked the same question; a difference in EITHER the artifact or the
    // forwarded argv is the defect an alias can silently introduce.
    const home = await mkdtemp(join(tmpdir(), "redskilled-bare-name-"));
    roots.push(home);
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(home, "dist"), { recursive: true });
    copyFileSync(BARE_SHIM, join(home, "bin", "redskilled.mjs"));
    copyFileSync(PREFIXED_SHIM, join(home, "bin", "red-skills-redskilled.mjs"));
    writeFileSync(
      join(home, "dist", REDSKILLED_BUNDLE_ASSET),
      'process.stdout.write(`entry ${import.meta.url} argv ${process.argv.slice(2).join(" ")}\\n`);\n',
    );

    const answers = ["redskilled.mjs", "red-skills-redskilled.mjs"].map((name) =>
      spawnSync(process.execPath, [join(home, "bin", name), "--version", "--json"], {
        encoding: "utf8",
      }),
    );

    expect(answers[0]!.status).toBe(0);
    expect(answers[0]!.stdout).toContain("--version --json");
    expect(answers[0]!.stdout).toBe(answers[1]!.stdout);
  });

  it("routes `serve` under either name, so a spawn through one is a redskilled entry", () => {
    expect(isRedskilledEntryPath("/usr/local/bin/redskilled")).toBe(true);
    expect(isRedskilledEntryPath("/opt/red/bin/redskilled.mjs")).toBe(true);
    expect(isRedskilledEntryPath("/opt/red/bin/red-skills-redskilled.mjs")).toBe(true);
    // Still not a licence for any nearby name: the check names entries, not prefixes.
    expect(isRedskilledEntryPath("/opt/red/bin/redskilled-helper.mjs")).toBe(false);
  });
});

describe("the clone launcher runs without a registry", () => {
  it("is present and executable in the checkout", () => {
    expect(existsSync(LAUNCHER), "bin/redskilled is missing from the clone").toBe(true);
    expect(statSync(LAUNCHER).mode & 0o111, "bin/redskilled is not executable").not.toBe(0);
  });

  it("answers --help with the usage constant, from anywhere", () => {
    // Run from a foreign cwd on purpose: the launcher must resolve the checkout
    // from its OWN path, because an operator running it by absolute path while
    // standing in the broken project is the case it exists for.
    const help = spawnSync(LAUNCHER, ["--help"], { encoding: "utf8", cwd: tmpdir() });

    expect(help.status, `bin/redskilled --help failed: ${help.stderr}`).toBe(0);
    expect(help.stdout).toBe(REDSKILLED_USAGE);
  });

  it("answers --version off the build stamp", () => {
    const version = spawnSync(LAUNCHER, ["--version"], { encoding: "utf8", cwd: ROOT });

    expect(version.status, `bin/redskilled --version failed: ${version.stderr}`).toBe(0);
    // `app version gitSha` — `renderVersion` over the stamp, and nothing else:
    // the answer is asked precisely when the config, the store and the socket
    // are the things that are broken.
    expect(version.stdout.trimEnd()).toMatch(/^redskilled \S+ \S+$/);
  });
});

describe("the docs say which form is canonical", () => {
  it("names the pinned `-p` dispatch canonical and the bare name an alias", () => {
    const readme = readFileSync(join(APP, "README.md"), "utf8");

    expect(readme).toContain("npx -y -p @reddb-io/red-skills@<version> redskilled");
    expect(readme).toMatch(/canonical/i);
    expect(readme).toMatch(/alias/i);
  });
});
