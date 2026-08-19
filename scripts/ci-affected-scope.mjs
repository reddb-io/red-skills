#!/usr/bin/env node
// ci-affected-scope — compute the CI gate's affected cone from a changed-file set.
//
// The AFK feedback gate already scopes validation to the dependency cone of a
// change (apps/plugin-dev/src/core/validation-scope.ts). CI had no equivalent, so the
// same narrow diff was cheap when a worker validated it and a full-workspace
// run when GitHub did. This script gives red-workspace-ci.yml the same cone, on
// the same principle: touched packages plus every package that transitively
// depends on them.
//
// Two rules keep the narrowing honest:
//
//   1. Unclassifiable wins the whole workspace. Every path is matched against an
//      explicit table; a path that matches nothing escalates to the full suite,
//      because a wrongly-skipped test costs far more than a needlessly-run one.
//   2. Docs are not inert here. This repo's apps/plugin-dev suite asserts the content of
//      `.red/**` and `plugins/**` (the *-docs.test.ts contracts, ADR governance,
//      pi package payloads), so a docs-only change still runs apps/plugin-dev — it just
//      stops paying for typecheck and for every unrelated package's suite.
//
// Usage:
//   node scripts/ci-affected-scope.mjs --files-stdin [--github-output]
//   node scripts/ci-affected-scope.mjs --base <ref> --head <ref> [--github-output]
//   node scripts/ci-affected-scope.mjs --whole-workspace [--github-output]
//
// Prints the scope as JSON on stdout. With --github-output it also appends
// `mode`, `trigger`, `test_packages` (JSON array), `run_typecheck` and
// `run_manifest_checks` to $GITHUB_OUTPUT.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------- workspace graph ----------

/** Workspace package globs, mirroring pnpm-workspace.yaml's `packages:` list. */
const PACKAGE_ROOTS = ['apps', 'packages'];

/** @returns {{dir: string, name: string, dependsOn: string[]}[]} */
function readWorkspaceGraph(repoRoot) {
  const manifests = [];
  for (const root of PACKAGE_ROOTS) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      manifests.push({ dir, pkg });
    }
  }

  const dirByName = new Map(manifests.map(({ dir, pkg }) => [pkg.name, dir]));
  return manifests.map(({ dir, pkg }) => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const dependsOn = Object.entries(deps)
      .filter(([name, range]) =>
        typeof range === 'string' && range.startsWith('workspace:') && dirByName.has(name))
      .map(([name]) => dirByName.get(name));
    return { dir, name: pkg.name, dependsOn: [...new Set(dependsOn)].sort() };
  });
}

/** Touched dirs → touched dirs plus every transitive dependent, byte-sorted. */
function expandToCone(touchedDirs, graph) {
  const reverseDeps = new Map();
  for (const pkg of graph) {
    for (const dep of pkg.dependsOn) {
      if (!reverseDeps.has(dep)) reverseDeps.set(dep, []);
      reverseDeps.get(dep).push(pkg.dir);
    }
  }

  const cone = new Set(touchedDirs);
  const queue = [...touchedDirs];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const dependent of reverseDeps.get(dir) ?? []) {
      if (cone.has(dependent)) continue;
      cone.add(dependent);
      queue.push(dependent);
    }
  }
  return [...cone].sort();
}

// ---------- path classification ----------

/**
 * Doc lanes that no suite reads. Keep this list short and provable: anything
 * added here is a promise that no test asserts the file's content.
 */
const INERT_PREFIXES = ['.red/researches/', '.red/tmp/', '.changeset/'];

/**
 * Doc lanes whose content apps/plugin-dev's suite asserts — the *-docs.test.ts
 * contracts, ADR governance, the skill/manifest audits. A change here runs
 * apps/plugin-dev's tests but affects no type.
 */
const DOC_PREFIXES = ['.red/'];

/**
 * Doc lanes that are ALSO inputs to generated artifacts (Codex/Pi manifests,
 * Pi package payloads), so they additionally re-run the manifest checks.
 */
const MANIFEST_INPUT_PREFIXES = ['plugins/', '.claude-plugin/', '.agents/', 'packaging/pi/'];

/** Root-level docs that the suite reads (README/CLAUDE/CHANGES are asserted). */
const ROOT_DOC_FILES = new Set(['README.md', 'CLAUDE.md', 'NOTICE', 'LICENSE']);

/** Source-file extensions — anything else inside a package is docs/fixtures. */
const TYPED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

function stripDotSlash(file) {
  return file.startsWith('./') ? file.slice(2) : file;
}

function packageDirFor(file, graph) {
  // Longest-prefix match, so packages/worker wins over a shorter sibling.
  let best;
  for (const pkg of graph) {
    if (!file.startsWith(`${pkg.dir}/`)) continue;
    if (best === undefined || pkg.dir.length > best.length) best = pkg.dir;
  }
  return best;
}

/**
 * Classify one changed path.
 * @returns {{kind: 'whole'} | {kind: 'inert'} | {kind: 'scoped', packages: string[], typecheck: boolean, manifests: boolean}}
 */
function classify(file, graph) {
  const clean = stripDotSlash(file);

  // `.red/` docs that the ADR/pi payload builders read are manifest inputs too.
  if (clean.startsWith('.red/adr/')) {
    return { kind: 'scoped', packages: ['apps/plugin-dev'], typecheck: false, manifests: true };
  }
  if (INERT_PREFIXES.some((p) => clean.startsWith(p))) return { kind: 'inert' };
  if (MANIFEST_INPUT_PREFIXES.some((p) => clean.startsWith(p))) {
    return { kind: 'scoped', packages: ['apps/plugin-dev'], typecheck: false, manifests: true };
  }
  if (DOC_PREFIXES.some((p) => clean.startsWith(p))) {
    // `.red/config.yaml` is repo configuration the runtimes read, not prose —
    // it does not get the docs discount.
    if (clean === '.red/config.yaml') return { kind: 'whole' };
    return { kind: 'scoped', packages: ['apps/plugin-dev'], typecheck: false, manifests: false };
  }

  if (!clean.includes('/')) {
    if (ROOT_DOC_FILES.has(clean)) {
      return { kind: 'scoped', packages: ['apps/plugin-dev'], typecheck: false, manifests: false };
    }
    // Every other root file (package.json, lockfile, turbo.json, tsconfig, …)
    // has global blast radius.
    return { kind: 'whole' };
  }

  const dir = packageDirFor(clean, graph);
  if (dir !== undefined) {
    // A package's own manifest can change its build/test wiring, and apps/*
    // versions feed the generated Pi packages.
    const isManifest = clean === `${dir}/package.json`;
    const typecheck = TYPED_EXTENSIONS.some((ext) => clean.endsWith(ext));
    return { kind: 'scoped', packages: [dir], typecheck, manifests: isManifest };
  }

  // scripts/**, .github/**, dist/**, anything unrecognised: unclassifiable.
  return { kind: 'whole' };
}

// ---------- scope computation ----------

export function computeCiScope(changedFiles, graph) {
  const files = changedFiles.map(stripDotSlash).filter((f) => f !== '');
  const allPackages = graph.map((p) => p.dir).sort();

  const whole = (trigger) => ({
    mode: 'whole-workspace',
    trigger,
    testPackages: allPackages,
    triggerPackages: allPackages,
    runTypecheck: true,
    runManifestChecks: true,
  });

  // No files means the diff could not be established — fall back, never narrow
  // on an unknown change set.
  if (files.length === 0) return whole('(no changed files resolved)');

  const touched = new Set();
  let typecheck = false;
  let manifests = false;
  for (const file of files) {
    const verdict = classify(file, graph);
    if (verdict.kind === 'whole') return whole(file);
    if (verdict.kind === 'inert') continue;
    for (const pkg of verdict.packages) touched.add(pkg);
    typecheck ||= verdict.typecheck;
    manifests ||= verdict.manifests;
  }

  const triggerPackages = [...touched].sort();
  return {
    mode: 'cone',
    trigger: null,
    testPackages: expandToCone(triggerPackages, graph),
    triggerPackages,
    runTypecheck: typecheck,
    runManifestChecks: manifests,
  };
}

// ---------- CLI ----------

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function changedFilesFromGit(base, head) {
  const range = `${base}...${head}`;
  const out = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' });
  return out.split('\n');
}

function main(argv) {
  const repoRoot = process.cwd();
  const graph = readWorkspaceGraph(repoRoot);

  const has = (flag) => argv.includes(flag);
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  let changedFiles;
  if (has('--whole-workspace')) {
    changedFiles = [];
  } else if (has('--files-stdin')) {
    changedFiles = readStdin().split('\n');
  } else if (has('--base')) {
    try {
      changedFiles = changedFilesFromGit(value('--base'), value('--head') ?? 'HEAD');
    } catch (err) {
      // A diff we cannot compute is an unknown change set: run everything.
      process.stderr.write(`ci-affected-scope: git diff failed (${err.message})\n`);
      changedFiles = [];
    }
  } else {
    process.stderr.write('ci-affected-scope: pass --files-stdin, --base <ref>, or --whole-workspace\n');
    process.exit(2);
  }

  const scope = computeCiScope(changedFiles, graph);
  process.stdout.write(`${JSON.stringify(scope, null, 2)}\n`);

  if (has('--github-output') && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `mode=${scope.mode}`,
        `trigger=${scope.trigger ?? ''}`,
        `test_packages=${JSON.stringify(scope.testPackages)}`,
        `run_typecheck=${scope.runTypecheck}`,
        `run_manifest_checks=${scope.runManifestChecks}`,
        '',
      ].join('\n'),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
