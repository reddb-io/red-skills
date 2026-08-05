#!/usr/bin/env node
// validate-changesets — every pending changeset must resolve against this
// workspace, checked while the PR is open (#2863).
//
// The Release standard does not skip a changeset it cannot resolve. It throws,
// and the whole release plan dies with it. One file saying `"red-skills"` (the
// ROOT manifest's name, which is not a workspace package) where every other one
// says `"@reddb-io/red-skills"` failed three consecutive release runs over half
// an hour, left npm on the previous version, and reported nothing until someone
// opened the job log.
//
// Nothing caught it earlier because nothing validated a changeset at PR time —
// `test`, `typecheck`, the scope check and the marketplace validation all pass a
// bad changeset, since none of them resolve the release plan. This script does,
// with no dependency on an installed `@changesets/cli`, so it can run in the
// unconditional workflow-security job: `.changeset/` is INERT to
// scripts/ci-affected-scope.mjs, so a changeset-only PR runs no other heavy job.
//
// Usage:
//   node scripts/validate-changesets.mjs              # this repo
//   node scripts/validate-changesets.mjs --root DIR   # another checkout
//
// Exits 0 when every changeset resolves — including when there are none at all.
// Exits 1 naming each offending file, the unknown package, and the workspace
// name the author most likely meant.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The bumps `@changesets/types` accepts. Anything else aborts the plan too. */
const VERSION_TYPES = new Set(["major", "minor", "patch", "none"]);

// ---------- workspace ----------

/**
 * The `packages:` globs from pnpm-workspace.yaml. Read rather than mirrored, so
 * a new package root cannot silently fall outside this check.
 */
function readWorkspaceGlobs(root) {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const globs = [];
  let inPackages = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item) break; // the next top-level key ends the list
    globs.push(unquote(item[1]));
  }
  return globs;
}

function unquote(value) {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) return quoted[2];
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * Workspace package names, resolved from the globs. Only the two shapes this
 * repo uses are supported — a literal directory and a `<prefix>/*` fan-out; an
 * unsupported pattern throws rather than narrowing the check silently.
 *
 * The ROOT manifest is deliberately absent: the engine resolves against
 * the glob-matched packages, so the root's own name is exactly the name that
 * broke the release.
 */
function readWorkspacePackageNames(root) {
  const names = new Set();
  for (const glob of readWorkspaceGlobs(root)) {
    if (glob.includes("!")) throw new Error(`unsupported workspace pattern: ${glob}`);
    const star = glob.indexOf("*");
    if (star === -1) {
      addPackageName(names, join(root, glob));
      continue;
    }
    if (!glob.endsWith("/*") || glob.slice(0, -2).includes("*")) {
      throw new Error(`unsupported workspace pattern: ${glob}`);
    }
    const parent = join(root, glob.slice(0, -2));
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) addPackageName(names, join(parent, entry.name));
    }
  }
  return names;
}

function addPackageName(names, dir) {
  try {
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    if (typeof name === "string" && name !== "") names.add(name);
  } catch {
    // Not a package directory; the workspace ignores it and so do we.
  }
}

// ---------- changesets ----------

/** The pending changeset files, exactly the set `@changesets/read` picks up. */
function readChangesetFiles(root) {
  const dir = join(root, ".changeset");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no .changeset at all — nothing pending, nothing to resolve
  }
  return entries
    .filter((file) => file.endsWith(".md") && file !== "README.md" && !file.startsWith("."))
    .sort();
}

/**
 * The `name: bump` pairs in a changeset's frontmatter, with the line each sits
 * on so a failure can point at it. An empty frontmatter block is a valid
 * changeset that releases nothing, and yields no pairs.
 *
 * @returns {{releases: {name: string, bump: string, line: number}[]} | {error: string}}
 */
function parseFrontmatter(source) {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { error: "no `---` frontmatter block — the release engine cannot read this file" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { error: "the `---` frontmatter block is never closed" };

  const releases = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const pair = /^\s*(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*(.+?)\s*$/.exec(line);
    if (!pair) return { error: `frontmatter line ${index + 1} is not a \`"package": bump\` pair` };
    releases.push({
      name: pair[1] ?? pair[2] ?? pair[3],
      bump: unquote(pair[4]),
      line: index + 1,
    });
  }
  return { releases };
}

/**
 * The workspace name an unknown name most likely meant: the single package whose
 * scoped name ends with `/<unknown>`. Ambiguity yields nothing rather than a
 * guess that sends the author to the wrong package.
 */
function suggestionFor(unknown, workspaceNames) {
  const matches = [...workspaceNames].filter((name) => name.endsWith(`/${unknown}`));
  return matches.length === 1 ? matches[0] : null;
}

// ---------- run ----------

export function run(argv = [], { root = REPO_ROOT, log = console.log, error = console.error } = {}) {
  let target = root;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") target = resolve(argv[++i] ?? "");
    else if (argv[i].startsWith("--root=")) target = resolve(argv[i].slice("--root=".length));
    else throw new Error(`unknown argument: ${argv[i]}`);
  }

  const files = readChangesetFiles(target);
  if (files.length === 0) {
    log("changesets ok — no pending changeset to resolve");
    return 0;
  }

  const workspaceNames = readWorkspacePackageNames(target);
  const problems = [];

  for (const file of files) {
    const relative = `.changeset/${file}`;
    const parsed = parseFrontmatter(readFileSync(join(target, ".changeset", file), "utf8"));
    if (parsed.error) {
      problems.push({ file: relative, line: 1, message: parsed.error });
      continue;
    }
    for (const release of parsed.releases) {
      if (!workspaceNames.has(release.name)) {
        const suggestion = suggestionFor(release.name, workspaceNames);
        problems.push({
          file: relative,
          line: release.line,
          message:
            `"${release.name}" is not a package in this workspace, so the release engine ` +
            `throws and abandons the WHOLE release plan` +
            (suggestion ? ` — did you mean "${suggestion}"?` : ""),
        });
      }
      if (!VERSION_TYPES.has(release.bump)) {
        problems.push({
          file: relative,
          line: release.line,
          message:
            `"${release.bump}" is not a release type, so the release engine throws and ` +
            `abandons the WHOLE release plan — use ${[...VERSION_TYPES].join(", ")}`,
        });
      }
    }
  }

  if (problems.length === 0) {
    log(`changesets ok — ${files.length} pending changeset(s) resolve against the workspace`);
    return 0;
  }

  for (const problem of problems) {
    error(`::error file=${problem.file},line=${problem.line}::${problem.file}: ${problem.message}`);
  }
  error(
    `${problems.length} changeset problem(s). Fix them here: after merge this fails every ` +
      `release run, not just this PR.`,
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
