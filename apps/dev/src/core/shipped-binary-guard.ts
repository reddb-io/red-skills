// shipped-binary-guard — the ratchet that holds every SHIPPED binary to the two
// answers a binary owes before anything else works (issue #2878).
//
// Two shipped binaries went without a version surface and nobody noticed until
// someone tested them one by one. The convergence tickets (#2873–#2877) fixed the
// five offenders that existed; nothing stopped the sixth. A binary is added by
// writing one line in a `bin` map, and that line carries no obligation — so the
// obligation has to be checked from the `bin` map itself, not from a hand-kept
// list that a new binary is never added to.
//
// Discovery therefore starts where the binary is DECLARED. Every `bin` entry in
// every workspace `package.json` is a shipped binary, resolved to the source that
// actually runs:
//
//  1. The target exists in the tree (`packaging/npm/bin/rsp.mjs`) → that file.
//  2. The target is a build output (`dist/cli.js`) → its `src/cli.ts` sibling.
//  3. The file is a SHIM that forwards its whole argv to a packaged bundle →
//     follow it. A shim owes nothing itself; it inherits the answers of the
//     bundle it execs, whose entry the owning package's `bundle` script names.
//
// Two obligations, both checked over the resolved entry:
//
//  - **A VERSION ANSWER, from the build stamp.** `renderVersion`/`readBuildInfo`
//    read a constant compiled into the artifact. That is the point, not an
//    implementation detail: `--version` is asked of a binary that is misbehaving,
//    in a directory that never ran `init`, precisely when the config is wrong, the
//    store is missing or the socket is dead. An answer assembled from any of those
//    is unavailable exactly when it is needed, so the version surface must come
//    from the stamp and nothing else.
//  - **ARGUMENTS THROUGH THE SHARED CONTRACT.** A binary that walks `process.argv`
//    itself re-decides what `--version` spells, whether `-v` is an alias, and
//    whether `--json` survives — which is how five binaries ended up with five
//    argument surfaces. `process.argv` may be READ (handed whole to the parser,
//    or sliced to drop the interpreter and the script); it may not be WALKED.
//
// Prose is not an answer: comments are stripped before matching, so a header
// promising a version surface never stands in for the surface.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "./extinct-source-guard.js";

/** Where a human looks when the invariant fires, named in the failure message. */
export const SHIPPED_BINARY_GUARD_SOURCE = "apps/dev/src/core/shipped-binary-guard.ts";

/** One source file the guard can read, keyed by its repo-relative path. */
export interface BinarySourceFile {
  relativePath: string;
  sourceText: string;
}

/** A workspace `package.json`, reduced to what declares and builds binaries. */
export interface BinaryPackageManifest {
  /** Repo-relative dir of the package, e.g. `apps/rsp` (never a file path). */
  dir: string;
  /** The `bin` map verbatim: binary name → target path, relative to `dir`. */
  bin: Readonly<Record<string, string>>;
  /** The `scripts` map verbatim — the bundle scripts name each bundle's entry. */
  scripts: Readonly<Record<string, string>>;
}

/** A binary as DECLARED — the obligation exists from this line onward. */
export interface DeclaredBinary {
  /** The name the binary is installed as, e.g. `red-skills-dev`. */
  name: string;
  /** Repo-relative `package.json` that declares it — where a human edits. */
  declaredIn: string;
  /** Repo-relative target the `bin` map points at. */
  target: string;
}

/** A declared binary resolved to the source that actually runs. */
export interface ResolvedBinary extends DeclaredBinary {
  /** Repo-relative entry source, or undefined when nothing resolved. */
  entry?: string;
  /** Every file the resolution walked through, entry last (shim → bundle entry). */
  hops: readonly string[];
}

/** Why a binary fails its obligations. One binary may raise several. */
export type ShippedBinaryViolationKind =
  | "unresolved-entry"
  | "no-version-answer"
  | "no-version-route"
  | "argv-walk";

export interface ShippedBinaryViolation {
  binary: string;
  kind: ShippedBinaryViolationKind;
  /** Repo-relative file the failure points at — the entry, or the offending file. */
  file: string;
  /** 1-based line, present only for a violation anchored to a call site. */
  line?: number;
  /** The offending source fragment, present for `argv-walk`. */
  evidence?: string;
}

// ---------------------------------------------------------------------------
// declaration
// ---------------------------------------------------------------------------

/**
 * Every binary declared by every manifest's `bin` map, sorted by name so a
 * failure reads the same on every run. PURE.
 */
export function collectDeclaredBinaries(
  manifests: readonly BinaryPackageManifest[],
): DeclaredBinary[] {
  const binaries: DeclaredBinary[] = [];
  for (const manifest of manifests) {
    for (const [name, target] of Object.entries(manifest.bin)) {
      binaries.push({
        name,
        declaredIn: joinRelative(manifest.dir, "package.json"),
        target: joinRelative(manifest.dir, target),
      });
    }
  }
  return binaries.sort((a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target));
}

/** `--entry <src>` … `--outfile …/<name>` … `--asset <name>` in a bundle script. */
const BUNDLE_ENTRY = /--entry\s+(\S+)/;
const BUNDLE_OUTFILE = /--outfile[=\s]+(\S+)/;
const BUNDLE_ASSET = /--asset\s+(\S+)/;

/**
 * Bundle basename → repo-relative entry source, read from the `bundle*` scripts.
 *
 * Both the `--outfile` basename and the `--asset` name are indexed: a shim execs
 * the bundle by the name it SHIPS as, which is the asset name, and that is not
 * always the outfile's (code-nav builds `code-nav-mcp.bundle.min.mjs` and ships it
 * as `code-nav.bundle.min.mjs`). Indexing only one of the two would leave a real
 * binary unresolved and read as a green pass. PURE.
 */
export function collectBundleEntries(
  manifests: readonly BinaryPackageManifest[],
): Map<string, string> {
  const entries = new Map<string, string>();
  for (const manifest of manifests) {
    for (const script of Object.values(manifest.scripts)) {
      const entry = BUNDLE_ENTRY.exec(script)?.[1];
      if (entry === undefined) continue;
      const resolved = joinRelative(manifest.dir, entry);
      for (const pattern of [BUNDLE_OUTFILE, BUNDLE_ASSET]) {
        const named = pattern.exec(script)?.[1];
        if (named === undefined) continue;
        entries.set(basename(named), resolved);
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** `dist/<x>.js` — a build output whose source is the package's `src/<x>.ts`. */
const BUILD_OUTPUT = /^(.*)dist\/(.+)\.(?:js|mjs|cjs)$/;
/** A shim's `dist/<name>.bundle.min.mjs` target, as spelled in the shim's source. */
const SPAWNED_BUNDLE = /["'`]([\w.-]+\.bundle(?:\.min)?\.mjs)["'`]/;
/** The forwarding that makes a file a shim rather than a binary of its own. */
const FORWARDS_WHOLE_ARGV = /process\s*\.\s*argv\s*\.\s*slice\s*\(\s*2\s*\)/;

/**
 * Resolve a declared binary to the source that actually runs, following at most
 * one shim hop. A shim that forwards its whole argv to a packaged bundle owes no
 * answers of its own — it inherits the bundle's — so the obligation must be
 * checked against the bundle's entry, not against the shim. PURE.
 */
export function resolveBinaryEntry(
  binary: DeclaredBinary,
  files: ReadonlyMap<string, BinarySourceFile>,
  bundles: ReadonlyMap<string, string>,
): ResolvedBinary {
  const direct = resolveTargetSource(binary.target, files);
  if (direct === undefined) return { ...binary, hops: [] };

  const source = stripComments(files.get(direct)!.sourceText);
  const bundle = SPAWNED_BUNDLE.exec(source)?.[1];
  if (bundle === undefined || !FORWARDS_WHOLE_ARGV.test(source)) {
    return { ...binary, entry: direct, hops: [direct] };
  }

  const delegate = bundles.get(bundle);
  if (delegate === undefined || !files.has(delegate)) {
    return { ...binary, hops: [direct] };
  }
  return { ...binary, entry: delegate, hops: [direct, delegate] };
}

function resolveTargetSource(
  target: string,
  files: ReadonlyMap<string, BinarySourceFile>,
): string | undefined {
  if (files.has(target)) return target;
  const output = BUILD_OUTPUT.exec(target);
  if (output === null) return undefined;
  for (const extension of [".ts", ".mts", ".tsx", ".mjs"]) {
    const candidate = `${output[1]}src/${output[2]}${extension}`;
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the module chain
// ---------------------------------------------------------------------------

/** A relative specifier in a static `import`/`export … from`, or a dynamic import. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;

/**
 * Every repo file reachable from `entry` through relative imports, entry first.
 *
 * Package specifiers are NOT followed: a binary's own modules are what implement
 * its argument surface, and a dependency's argv handling is that dependency's
 * contract. `maxDepth` bounds how far an obligation can be pushed away from the
 * entry — the version answer is owed near the front door, the argument discipline
 * holds all the way down. PURE.
 */
export function collectModuleChain(
  entry: string,
  files: ReadonlyMap<string, BinarySourceFile>,
  maxDepth = Number.POSITIVE_INFINITY,
): string[] {
  const seen = new Set<string>([entry]);
  const chain: string[] = [entry];
  let frontier = [entry];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const imported of importedPaths(current, files)) {
        if (seen.has(imported)) continue;
        seen.add(imported);
        chain.push(imported);
        next.push(imported);
      }
    }
    frontier = next;
  }
  return chain;
}

function importedPaths(from: string, files: ReadonlyMap<string, BinarySourceFile>): string[] {
  const file = files.get(from);
  if (file === undefined) return [];
  const dir = dirname(from);
  const found: string[] = [];
  for (const match of stripComments(file.sourceText).matchAll(RELATIVE_SPECIFIER)) {
    const resolved = resolveRelativeImport(dir, match[1]!, files);
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
}

function resolveRelativeImport(
  dir: string,
  specifier: string,
  files: ReadonlyMap<string, BinarySourceFile>,
): string | undefined {
  const base = joinRelative(dir, specifier);
  const stripped = base.replace(/\.(?:js|mjs|cjs)$/, "");
  for (const candidate of [
    base,
    `${stripped}.ts`,
    `${stripped}.mts`,
    `${stripped}.tsx`,
    `${stripped}.mjs`,
    `${stripped}/index.ts`,
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the two obligations
// ---------------------------------------------------------------------------

/**
 * How far from the entry the version answer may live. Two hops covers the shapes
 * every converged binary uses — answered in the entry, or in the single module the
 * entry delegates its whole command surface to. Depth alone is not the guard: the
 * ROUTE and the ANSWER must sit in the SAME file, so a `readBuildInfo` call in an
 * unrelated runtime module cannot stand in for a version surface that no flag reaches.
 */
export const VERSION_SURFACE_DEPTH = 2;

/**
 * The answer read off the build stamp — available when nothing else is.
 *
 * `renderVersion` specifically, not any mention of a version: it is the shared
 * renderer over `readBuildInfo`, and a file that calls it is printing this binary's
 * build identity rather than comparing a schema version or stamping a payload.
 */
const VERSION_ANSWER = /\brenderVersion\s*\(/;
/** The route that reaches it: a `--version` flag, a `version` command, or `-v`. */
const VERSION_ROUTE = /--version\b|\bversion\s*:\s*\{|["']version["']/;

/** `process.argv` followed by a member access — the shape that reads a token. */
const ARGV_ACCESS = /process\s*\.\s*argv\s*(?:\.\s*(\w+)\s*(\(\s*(\d+)?[^)]*\))?|\[\s*(\d+)\s*\])/g;

/**
 * True when this `process.argv` access merely READS argv rather than walking it.
 *
 * Handing the whole array to a parser, dropping the interpreter and the script
 * (`slice(1)` / `slice(2)`), and naming the interpreter or the script path
 * (`[0]` / `[1]`) are all reads. `slice(3)`, `[2]`, and every other method —
 * `includes`, `indexOf`, `find`, `filter` — are the binary deciding for itself
 * what its own flags mean. PURE.
 */
export function isArgvRead(method: string | undefined, sliceStart: string | undefined, index: string | undefined): boolean {
  if (index !== undefined) return index === "0" || index === "1";
  if (method !== "slice") return false;
  return sliceStart === undefined || sliceStart === "0" || sliceStart === "1" || sliceStart === "2";
}

/**
 * Every place a file walks `process.argv` instead of routing it, with the line
 * and the offending fragment. An empty array is the healthy state. PURE.
 */
export function findArgvWalks(file: BinarySourceFile): { line: number; evidence: string }[] {
  const walks: { line: number; evidence: string }[] = [];
  const lines = stripComments(file.sourceText).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index]!.matchAll(ARGV_ACCESS)) {
      if (isArgvRead(match[1], match[3], match[4])) continue;
      walks.push({ line: index + 1, evidence: match[0].trim() });
    }
  }
  return walks;
}

function text(files: ReadonlyMap<string, BinarySourceFile>, path: string): string {
  return stripComments(files.get(path)?.sourceText ?? "");
}

/**
 * True when the file that PRINTS the version also declares the route that reaches
 * it, or delegates that declaration to a module it imports directly.
 *
 * The direction is load-bearing. A binary that keeps its flag schema in its own
 * `cli-args` module still owns the route; a `version` token in some module that
 * merely happens to be nearby does not reach this answer at all. PURE.
 */
export function routesVersion(
  answeringPath: string,
  files: ReadonlyMap<string, BinarySourceFile>,
): boolean {
  return collectModuleChain(answeringPath, files, 1).some((path) =>
    VERSION_ROUTE.test(text(files, path)),
  );
}

/**
 * Every obligation no shipped binary meets. An empty array is the healthy state.
 *
 * A binary that resolves to nothing raises `unresolved-entry` ALONE: the other two
 * checks have no file to read, and reporting them too would name a missing version
 * surface in a file that does not exist. PURE.
 */
export function findShippedBinaryViolations(
  binaries: readonly DeclaredBinary[],
  files: ReadonlyMap<string, BinarySourceFile>,
  bundles: ReadonlyMap<string, string>,
): ShippedBinaryViolation[] {
  const violations: ShippedBinaryViolation[] = [];
  for (const declared of binaries) {
    const resolved = resolveBinaryEntry(declared, files, bundles);
    if (resolved.entry === undefined) {
      violations.push({ binary: declared.name, kind: "unresolved-entry", file: declared.target });
      continue;
    }

    const surface = collectModuleChain(resolved.entry, files, VERSION_SURFACE_DEPTH);
    const answering = surface.filter((path) => VERSION_ANSWER.test(text(files, path)));
    if (answering.length === 0) {
      violations.push({ binary: declared.name, kind: "no-version-answer", file: resolved.entry });
    } else if (!answering.some((path) => routesVersion(path, files))) {
      violations.push({ binary: declared.name, kind: "no-version-route", file: answering[0]! });
    }

    for (const path of collectModuleChain(resolved.entry, files)) {
      for (const walk of findArgvWalks(files.get(path)!)) {
        violations.push({
          binary: declared.name,
          kind: "argv-walk",
          file: path,
          line: walk.line,
          evidence: walk.evidence,
        });
      }
    }
  }
  return violations;
}

/**
 * The failure message the invariant assertion carries. A bare array diff names
 * neither the binary nor what a user loses, so a worker reading its own gate
 * output would learn only that something broke. PURE.
 */
export function formatShippedBinaryFailureMessage(
  violations: readonly ShippedBinaryViolation[],
): string {
  if (violations.length === 0) return "";
  const lines = violations.map((violation) => {
    const at =
      violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
    return `  - ${violation.binary} — ${describeViolation(violation)}\n      at ${at}`;
  });
  return [
    `shipped-binary invariant (#2878): ${violations.length} unmet ${
      violations.length === 1 ? "obligation" : "obligations"
    } across the declared bin maps.`,
    ...lines,
    `A binary earns its bin entry by answering --version off the build stamp and` +
      ` routing its arguments through @reddb-io/shared/args.` +
      ` The obligations are defined in ${SHIPPED_BINARY_GUARD_SOURCE}.`,
  ].join("\n");
}

function describeViolation(violation: ShippedBinaryViolation): string {
  switch (violation.kind) {
    case "unresolved-entry":
      return (
        "its bin target resolves to no source in the tree, so nothing about it can be checked." +
        " Point the bin map at a file that exists, or at a dist output whose src sibling does"
      );
    case "no-version-answer":
      return (
        "it answers no --version. `--version` is asked of a binary that is already misbehaving," +
        " so answer it from the build stamp (`readBuildInfo`/`renderVersion`), never from config, a store, or a socket"
      );
    case "no-version-route":
      return (
        "it reads the build stamp but routes no --version to it, so the answer is unreachable." +
        " Declare `--version` (and `-v`) in the binary's flag schema or as a `version` command"
      );
    case "argv-walk":
      return (
        `it walks process.argv itself (\`${violation.evidence ?? "process.argv"}\`) instead of routing through` +
        " @reddb-io/shared/args, which is how each binary ends up with its own answer to what --version spells"
      );
  }
}

function joinRelative(dir: string, target: string): string {
  return normalizePath(join(dir, target));
}

function basename(path: string): string {
  return normalizePath(path).split("/").at(-1) ?? path;
}

function normalizePath(path: string): string {
  const normalized = sep === "/" ? path : path.split(sep).join("/");
  return normalized.replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx"]);
const SKIP_DIRS = new Set([".git", ".red", ".turbo", "coverage", "dist", "node_modules"]);

/** The roots a shipped binary can live under: the workspaces plus the npm package. */
export const BINARY_SOURCE_ROOTS = ["apps", "packages", "packaging"] as const;

/** Every `package.json` under the scanned roots that declares a `bin` map. */
export function readBinaryPackageManifests(root: string): BinaryPackageManifest[] {
  const manifests: BinaryPackageManifest[] = [];
  for (const sourceRoot of BINARY_SOURCE_ROOTS) {
    const absolute = join(root, sourceRoot);
    if (existsSync(absolute)) collectManifests(root, absolute, manifests);
  }
  return manifests.sort((a, b) => a.dir.localeCompare(b.dir));
}

function collectManifests(root: string, dir: string, out: BinaryPackageManifest[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectManifests(root, path, out);
      continue;
    }
    if (entry.name !== "package.json") continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      bin?: Record<string, string> | string;
      scripts?: Record<string, string>;
    };
    out.push({
      dir: normalizePath(relative(root, dir)),
      bin: typeof parsed.bin === "string" ? {} : (parsed.bin ?? {}),
      scripts: parsed.scripts ?? {},
    });
  }
}

/** Every source file under the scanned roots, keyed by repo-relative path. */
export function readBinarySourceFiles(root: string): Map<string, BinarySourceFile> {
  const files = new Map<string, BinarySourceFile>();
  for (const sourceRoot of BINARY_SOURCE_ROOTS) {
    const absolute = join(root, sourceRoot);
    if (existsSync(absolute)) collectSources(root, absolute, files);
  }
  return files;
}

function collectSources(root: string, dir: string, out: Map<string, BinarySourceFile>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSources(root, path, out);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
    const relativePath = normalizePath(relative(root, path));
    out.set(relativePath, { relativePath, sourceText: readFileSync(path, "utf8") });
  }
}
