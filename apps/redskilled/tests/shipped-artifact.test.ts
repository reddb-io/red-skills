// The daemon has to EXIST in production, and that is a delivery fact, not a
// source fact. `redskilled` was a complete, tested, wired-in workspace member
// that declared no bundle step, so the root bundle run fanned out over every
// other app and produced nothing for this one — and no release carried it. The
// subsystem was unreachable in production and NOTHING said so (issue #2842).
//
// These checks are the "something says so". Two halves, and they fail for
// different reasons: the DECLARATIONS half asserts every place a release keys
// off the artifact's name still names it, and the EXECUTABLE half builds the
// bundle and starts a daemon from it, because a present artifact that throws on
// load is the same outage as an absent one.
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDSKILLED_BUNDLE_ASSET, resolveRedskilledEntry } from "../src/client.js";
import { socketAnswers } from "../src/daemon.js";

const APP = resolve(__dirname, "..");
const ROOT = resolve(APP, "..", "..");
const BUNDLE = join(ROOT, "dist", REDSKILLED_BUNDLE_ASSET);
const WORKFLOW = join(ROOT, ".github", "workflows", "red-publish.yml");
const PREPARE = join(ROOT, "packaging", "npm", "scripts", "prepare.mjs");
const PACKAGING_PKG = join(ROOT, "packaging", "npm", "package.json");
const SHIM = join(ROOT, "packaging", "npm", "bin", "red-skills-redskilled.mjs");

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("redskilled ships as a bundled artifact", () => {
  it("declares the bundle step the root bundle run fans out over", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const bundle = pkg.scripts?.bundle;
    expect(bundle, "apps/redskilled must declare a `bundle` script — without it `pnpm bundle` skips the app entirely").toBeTruthy();
    expect(bundle).toContain("--entry src/cli.ts");
    expect(bundle).toContain(`--outfile ../../dist/${REDSKILLED_BUNDLE_ASSET}`);
    expect(bundle).toContain(`--asset ${REDSKILLED_BUNDLE_ASSET}`);
    expect(bundle).toContain("--minify");
    // `build` must reach `bundle`: a build that only typechecks is what let the
    // missing artifact look green for the whole of the app's life so far.
    expect(pkg.scripts?.build).toContain("bundle");
  });

  it("is staged into the npm package and reachable through a bin", () => {
    expect(readFileSync(PREPARE, "utf8")).toContain(REDSKILLED_BUNDLE_ASSET);
    const pkg = JSON.parse(readFileSync(PACKAGING_PKG, "utf8")) as { bin?: Record<string, string> };
    expect(pkg.bin?.["red-skills-redskilled"]).toBe("bin/red-skills-redskilled.mjs");
    expect(existsSync(SHIM)).toBe(true);
    expect(readFileSync(SHIM, "utf8")).toContain(REDSKILLED_BUNDLE_ASSET);
  });

  it("is built, packed, manifested and released by the publish workflow", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    // A build step, or the artifact never exists at pack time.
    expect(workflow).toContain("working-directory: apps/redskilled");
    // The tarball checklist, or a bin ships without the bundle it execs.
    expect(workflow).toContain(`package/dist/${REDSKILLED_BUNDLE_ASSET}`);
    // The release manifest + the Release asset list, or a published release
    // carries nothing for the daemon — the exact silence #2842 closed.
    expect(workflow).toContain(`dist/${REDSKILLED_BUNDLE_ASSET}`);
    const manifestStep = section(workflow, "- name: Build release manifest", "- name: GitHub Release");
    expect(manifestStep).toContain(`dist/${REDSKILLED_BUNDLE_ASSET}`);
    const releaseStep = section(workflow, "assets=(", "dist/release-manifest.json");
    expect(releaseStep).toContain(`dist/${REDSKILLED_BUNDLE_ASSET}`);
  });

  it("names the bundle as the daemon entry a spawn invokes, never the caller's own file", () => {
    const lookup = { execPath: "/usr/bin/node", execArgv: [], env: {}, listDir: () => [] };
    // Bundled: the artifact IS the entry, and no `cli.js` ships beside it.
    const bundled = resolveRedskilledEntry(
      {},
      { ...lookup, callerEntry: `/opt/red/dist/${REDSKILLED_BUNDLE_ASSET}`, exists: () => false },
    );
    expect(bundled).toMatchObject({ entry: `/opt/red/dist/${REDSKILLED_BUNDLE_ASSET}`, source: "caller-entry" });
    // Inlined into a foreign host bundle: the sibling artifact, NOT the host.
    const inlined = resolveRedskilledEntry(
      {},
      { ...lookup, callerEntry: "/opt/red/dist/dev.bundle.min.mjs", exists: () => true },
    );
    expect(inlined).toMatchObject({
      entry: `/opt/red/dist/${REDSKILLED_BUNDLE_ASSET}`,
      source: "caller-sibling-bundle",
    });
    // Compiled workspace layout: `apps/redskilled/dist/cli.js` is a redskilled
    // entry by package, so a caller inside the app resolves to itself.
    const workspace = resolveRedskilledEntry(
      {},
      { ...lookup, callerEntry: "/w/apps/redskilled/dist/cli.js", exists: () => false },
    );
    expect(workspace).toMatchObject({ entry: "/w/apps/redskilled/dist/cli.js", source: "caller-entry" });
  });

  it(
    "builds an artifact that starts the daemon rather than exiting",
    async () => {
      execFileSync("pnpm", ["run", "bundle"], {
        cwd: APP,
        env: {
          ...process.env,
          RED_BUILD_VERSION: "0.0.0-test",
          RED_BUILD_GIT_SHA: "test",
          RED_BUILD_TIME: "2026-01-01T00:00:00.000Z",
        },
        stdio: "pipe",
      });
      expect(existsSync(BUNDLE), `bundle run produced no ${REDSKILLED_BUNDLE_ASSET}`).toBe(true);

      const root = await mkdtemp(join(tmpdir(), "redskilled-artifact-"));
      roots.push(root);
      const socketPath = join(root, "redskilled.sock");
      const child = spawn(
        process.execPath,
        [
          BUNDLE,
          "serve",
          "--socket",
          socketPath,
          "--lease",
          join(root, "redskilled.lease.toon"),
          "--events",
          join(root, "redskilled.events.toonl"),
          "--idle-ms",
          "60000",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          // The machine dir is pinned to this test's own root, like every other
          // test here: without it the bundled daemon probes the REAL machine
          // claim and refuses to start whenever the host already runs one —
          // which says nothing about the artifact this check is about.
          env: { ...process.env, REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
        },
      );
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let exited: number | null = null;
      child.on("exit", (code) => {
        exited = code ?? -1;
      });

      const answered = await waitFor(async () => await socketAnswers(socketPath));
      expect(exited, `the bundled entry exited (${exited}) instead of serving: ${stderr}`).toBeNull();
      expect(answered, `the bundled entry never answered on its socket: ${stderr}`).toBe(true);
    },
    120_000,
  );
});

/** Poll a predicate to a deadline. Returns its last value. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** The slice of `text` between two markers — so a match must land in the right step. */
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `workflow is missing ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from);
  expect(to, `workflow is missing ${end} after ${start}`).toBeGreaterThan(-1);
  return text.slice(from, to);
}
