/**
 * The plugin has to be INSTALLABLE, and that is a delivery fact rather than a
 * source fact. `herdr plugin install reddb-io/red-skills/apps/herdr-plugin-red-skills`
 * downloads this directory alone, so the two workspace links the entry imports
 * resolve to nothing: the install "succeeded" and every pane died at the first
 * import (issue #3060). The cure is a single-file bundle attached to every
 * release and a build hook that writes it over the entry.
 *
 * Two halves, failing for different reasons. The DECLARATIONS half asserts every
 * place the release keys off the artifact's name still names it — a bundle
 * nothing builds is the same outage as one nothing downloads. The EXECUTABLE
 * half poses the no-workspace host: it builds the bundle, runs it from a
 * directory with no `node_modules` at all, and points it at a daemon. A live
 * herdr is not testable here (this repo pins no herdr), so what IS tested is
 * everything herdr would run: the materializer, the entry it produces, and that
 * entry's ability to reach a daemon.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// Asynchronous on purpose wherever a child talks to a server this process is
// running: `execFileSync` blocks the event loop that would have answered it.
const run = promisify(execFile);

import { rejectionReason, workspaceDependenciesResolve } from "../scripts/materialize-entrypoint.mjs";

const ROOT = join(import.meta.dirname, "..");
const REPO = join(ROOT, "..", "..");
const BUNDLE_ASSET = "herdr-plugin-red-skills.bundle.min.mjs";
const WORKFLOW = join(REPO, ".github", "workflows", "red-publish.yml");
const ENTRY_NAME = "red-skills-herdr.mjs";

/** The slice of `text` between two markers, so a match lands in the right step. */
function section(text, start, end) {
  const from = text.indexOf(start);
  assert.ok(from > -1, `workflow is missing ${start}`);
  const to = text.indexOf(end, from);
  assert.ok(to > -1, `workflow is missing ${end} after ${start}`);
  return text.slice(from, to);
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

test("declares the bundle step the root bundle run fans out over", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const bundle = pkg.scripts?.bundle;
  assert.ok(bundle, "apps/herdr-plugin-red-skills must declare a `bundle` script — without it `pnpm bundle` skips the app entirely");
  assert.match(bundle, /--entry bin\/red-skills-herdr\.mjs/);
  assert.ok(bundle.includes(`--outfile ../../dist/${BUNDLE_ASSET}`), bundle);
  assert.ok(bundle.includes(`--asset ${BUNDLE_ASSET}`), bundle);
  assert.ok(bundle.includes("--minify"), bundle);
  assert.ok(pkg.scripts?.build?.includes("bundle"), "`build` must reach `bundle`");
});

test("the install-time build hook materializes the entry on both platforms", () => {
  const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
  const build = section(manifest, "[[build]]", "# The notification watcher");
  const hooks = build.split("[[build]]").filter((chunk) => chunk.includes("command ="));
  assert.equal(hooks.length, 2, "one unix hook and its Windows twin");
  for (const hook of hooks) {
    assert.ok(
      hook.includes("materialize-entrypoint.mjs"),
      "a build hook that only preflights Node leaves an install that cannot run",
    );
  }
});

test("is built and released by the publish workflow", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.ok(workflow.includes("working-directory: apps/herdr-plugin-red-skills"), "no build step: the artifact never exists at release time");
  const manifestStep = section(workflow, "- name: Build release manifest", "- name: GitHub Release");
  assert.ok(manifestStep.includes(`dist/${BUNDLE_ASSET}`), "absent from the release manifest");
  const releaseStep = section(workflow, "assets=(", "dist/release-manifest.json");
  assert.ok(releaseStep.includes(`dist/${BUNDLE_ASSET}`), "absent from the Release assets — the build hook would download a 404");
});

test("the README documents the install that needs no checkout", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /herdr plugin install reddb-io\/red-skills\/apps\/herdr-plugin-red-skills/);
  assert.match(readme, /herdr plugin link apps\/herdr-plugin-red-skills/);
});

// ---------------------------------------------------------------------------
// the two pure halves of the materializer
// ---------------------------------------------------------------------------

test("a checkout resolves what the source entry imports", async () => {
  assert.equal(
    await workspaceDependenciesResolve(),
    true,
    "this checkout has run pnpm install, so the source entry is the one to run",
  );
});

test("refuses bytes that are not the bundle, naming which check said so", () => {
  const page = Buffer.from("<html>404: Not Found</html>", "utf8");
  assert.match(rejectionReason(page, page.toString("utf8")), /too small/);
  const big = Buffer.alloc(20_000, 0x20);
  assert.match(rejectionReason(big, big.toString("utf8")), /do not mention red-skills-herdr/);
  const real = Buffer.from(`${"// filler\n".repeat(2_000)}red-skills-herdr`, "utf8");
  assert.equal(rejectionReason(real, real.toString("utf8")), null);
});

// ---------------------------------------------------------------------------
// the no-workspace host
// ---------------------------------------------------------------------------

/** Build the shipped bundle into `outfile`, exactly as the release does. */
function buildBundle(outfile) {
  execFileSync(
    process.execPath,
    [
      join(REPO, "scripts", "bundle-app.mjs"),
      "--entry", "bin/red-skills-herdr.mjs",
      "--outfile", outfile,
      "--asset", BUNDLE_ASSET,
      "--minify",
    ],
    {
      cwd: ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        // esbuild is this package's own devDependency; a suite run outside a
        // pnpm script does not inherit the bin directory that resolves it.
        PATH: `${join(ROOT, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
        RED_BUILD_VERSION: "9.9.9-test",
        RED_BUILD_GIT_SHA: "testsha",
        RED_BUILD_TIME: "2026-01-01T00:00:00.000Z",
      },
    },
  );
  assert.ok(existsSync(outfile), `bundle run produced no ${BUNDLE_ASSET}`);
}

test("the build hook materializes a released bundle into a plugin root with no workspace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "red-skills-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const asset = join(dir, BUNDLE_ASSET);
  buildBundle(asset);

  // What `herdr plugin install` leaves behind: this directory's files, and no
  // node_modules anywhere above them.
  const root = join(dir, "plugin");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), readFileSync(join(ROOT, "package.json")));
  writeFileSync(join(root, "bin", ENTRY_NAME), readFileSync(join(ROOT, "bin", ENTRY_NAME)));
  writeFileSync(
    join(root, "scripts", "materialize-entrypoint.mjs"),
    readFileSync(join(ROOT, "scripts", "materialize-entrypoint.mjs")),
  );

  // The release, served over the wire the hook actually fetches over.
  const bytes = readFileSync(asset);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/${BUNDLE_ASSET}`;

  const entry = join(root, "bin", ENTRY_NAME);
  assert.ok(readFileSync(entry, "utf8").includes("import { readBuildInfo"), "the downloaded entry starts as the source one");

  await run(process.execPath, [join(root, "scripts", "materialize-entrypoint.mjs")], {
    env: { ...process.env, RED_SKILLS_HERDR_BUNDLE_URL: url },
  });

  assert.equal(readFileSync(entry).equals(bytes), true, "the entry herdr runs is now the self-contained bundle");
  // The whole point: a Node with no node_modules to find runs it.
  const version = execFileSync(process.execPath, [entry, "--version"], { cwd: dir, encoding: "utf8" });
  assert.match(version, /^red-skills-herdr 9\.9\.9-test testsha$/m);
  const usage = execFileSync(process.execPath, [entry, "--help"], { cwd: dir, encoding: "utf8" });
  assert.match(usage, /Usage: red-skills-herdr <command> \[options\]/);
});

test("the materialized entry reads a daemon from a host with no workspace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "red-skills-nows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const entry = join(dir, ENTRY_NAME);
  buildBundle(entry);

  const socketPath = join(dir, "redskilled.sock");
  const daemon = spawn(
    process.execPath,
    [join(ROOT, "scripts", "fake-daemon.mjs"), "--socket", socketPath, "--static"],
    { stdio: "ignore" },
  );
  t.after(() => daemon.kill("SIGKILL"));
  for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(socketPath), "the fake daemon never bound its socket");

  const line = execFileSync(process.execPath, [entry, "status"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      REDSKILLED_SOCKET: socketPath,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      NO_COLOR: "1",
    },
  });
  assert.match(line, /redskilled/, `a self-contained entry that cannot read a daemon is not installable: ${line}`);
});

test("a checkout materializes nothing — the source entry is the one a contributor edits", async () => {
  const before = readFileSync(join(ROOT, "bin", ENTRY_NAME));
  const { stdout } = await run(process.execPath, [join(ROOT, "scripts", "materialize-entrypoint.mjs")], {
    // A URL that would fail loudly if the checkout branch were not taken.
    env: { ...process.env, RED_SKILLS_HERDR_BUNDLE_URL: "http://127.0.0.1:1/nope" },
  });
  assert.match(stdout, /nothing to materialize/);
  assert.equal(readFileSync(join(ROOT, "bin", ENTRY_NAME)).equals(before), true);
});
