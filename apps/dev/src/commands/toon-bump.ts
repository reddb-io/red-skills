import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encode as encodeToon, type JsonValue as ToonValue } from "@reddb-io/toon";
import {
  findWorkspaceRoot,
  readCatalogToonVersion,
  TOON_PIN_SITES,
  type CatalogToonVersion,
  type ToonPinSite,
} from "../core/toon-version.js";

interface ToonBumpIO {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

interface ParsedToonBumpArgs {
  rootDir: string;
  targetVersion: string;
  dryRun: boolean;
}

interface FileEdit {
  path: string;
  text: string;
  replacements: Replacement[];
}

interface Replacement {
  site: string;
  before: string;
  after: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SCHEMA_VERSION = "red.dev.toon_bump.v1";

export async function toonBumpCommand(
  args: readonly string[],
  io: ToonBumpIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseToonBumpArgs(args);
    const previous = readCatalogToonVersion(parsed.rootDir);
    const target = toonVersion(parsed.targetVersion);
    const edits = await planToonBump(parsed.rootDir, previous, target);
    const status = edits.length === 0 ? "noop" : "changed";

    if (!parsed.dryRun) {
      for (const edit of edits) {
        await writeFile(resolve(parsed.rootDir, edit.path), edit.text, "utf8");
      }
    }

    io.stdout.write(
      `${encodeToon({
        schema_version: SCHEMA_VERSION,
        status,
        mode: parsed.dryRun ? "dry-run" : "apply",
        previous_version: previous.version,
        target_version: target.version,
        changes: edits.map((edit) => ({
          path: edit.path,
          replacements: edit.replacements,
        })),
      } as unknown as ToonValue)}\n`,
    );
    return status === "noop" ? 10 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${encodeToon({ schema_version: SCHEMA_VERSION, status: "failed", error: message })}\n`);
    return 1;
  }
}

async function planToonBump(rootDir: string, previous: CatalogToonVersion, target: CatalogToonVersion): Promise<FileEdit[]> {
  const edits = new Map<string, FileEdit>();
  await replaceInFile(edits, rootDir, "pnpm-workspace.yaml", (text) =>
    bumpWorkspaceYaml(text, previous.version, target.version),
  );
  await replaceInFile(edits, rootDir, "pnpm-lock.yaml", (text) => bumpLockfile(text, previous.version, target.version));

  for (const site of TOON_PIN_SITES) {
    await replaceInFile(edits, rootDir, site.path, (text) => bumpRegisteredSite(text, site, target));
  }

  return [...edits.values()];
}

async function replaceInFile(
  edits: Map<string, FileEdit>,
  rootDir: string,
  path: string,
  update: (text: string) => { text: string; replacements: Replacement[] },
): Promise<void> {
  const prior = edits.get(path);
  const original = prior?.text ?? await readFile(resolve(rootDir, path), "utf8");
  const next = update(original);
  if (next.replacements.length === 0) return;
  edits.set(path, {
    path,
    text: next.text,
    replacements: [...(prior?.replacements ?? []), ...next.replacements],
  });
}

function bumpWorkspaceYaml(text: string, previous: string, target: string): { text: string; replacements: Replacement[] } {
  if (previous === target) return { text, replacements: [] };
  const replacements: Replacement[] = [];
  let next = replaceFirstCapture(
    text,
    /(^\s*["']?@reddb-io\/toon["']?:\s*)(\d+\.\d+\.\d+)(\s*$)/m,
    target,
    "workspace.catalog",
    replacements,
  );

  const oldExclude = `@reddb-io/toon@${previous}`;
  const newExclude = `@reddb-io/toon@${target}`;
  if (next.includes(oldExclude)) {
    next = next.replace(oldExclude, newExclude);
    replacements.push({ site: "workspace.minimum-release-age-exclude", before: oldExclude, after: newExclude });
  } else if (!next.includes(newExclude)) {
    if (/^minimumReleaseAgeExclude:\s*$/m.test(next)) {
      next = next.replace(/(^minimumReleaseAgeExclude:\s*$)/m, `$1\n  - '${newExclude}'`);
    } else {
      next = `${next.replace(/\s*$/, "\n\n")}minimumReleaseAgeExclude:\n  - '${newExclude}'\n`;
    }
    replacements.push({ site: "workspace.minimum-release-age-exclude", before: "", after: newExclude });
  }

  return { text: next, replacements };
}

function bumpLockfile(text: string, previous: string, target: string): { text: string; replacements: Replacement[] } {
  if (previous === target) return { text, replacements: [] };
  const replacements: Replacement[] = [];
  const oldKey = `@reddb-io/toon@${previous}`;

  // A `packages:` entry carries the tarball integrity of the version in its key, so renaming the
  // key onto the target would assert that the new version hashes to the old bytes. `pnpm install`
  // rejects that, and a follow-up `--lockfile-only` will not repair it — pnpm reuses an entry whose
  // key already matches. Drop the stale block instead and let pnpm re-resolve the real resolution.
  let next = removeLockfileBlocks(text, oldKey, replacements);

  const lines = next.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = /^(\s*)'@reddb-io\/toon':\s*$/.exec(line);
    if (!match) continue;

    const blockIndent = match[1]!.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const child = lines[j]!;
      if (child.trim() !== "" && indentOf(child) <= blockIndent) break;
      if (!child.includes(previous)) continue;
      if (!/^\s+(specifier|version):\s+/.test(child)) continue;
      lines[j] = child.split(previous).join(target);
      replacements.push({ site: "lockfile.catalogs-and-importers", before: previous, after: target });
    }
  }

  return { text: lines.join("\n"), replacements };
}

function bumpRegisteredSite(
  text: string,
  site: ToonPinSite,
  target: CatalogToonVersion,
): { text: string; replacements: Replacement[] } {
  const expected = site.form === "tag" ? target.tag : target.version;
  const match = site.pattern.exec(text);
  if (!match?.[1]) {
    throw new Error(`toon pin site ${site.name} did not match ${site.path}`);
  }
  const actual = match[1];
  if (actual === expected) return { text, replacements: [] };
  const matchedText = match[0];
  const replacementText = matchedText.replace(actual, expected);
  return {
    text: `${text.slice(0, match.index)}${replacementText}${text.slice(match.index + matchedText.length)}`,
    replacements: [{ site: site.name, before: actual, after: expected }],
  };
}

/** Removes every `'<key>':` mapping and the indented block under it. */
function removeLockfileBlocks(text: string, key: string, replacements: Replacement[]): string {
  const lines = text.split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = new RegExp(`^(\\s*)'?${escapeRegExp(key)}'?:`).exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }

    const blockIndent = match[1]!.length;
    while (i + 1 < lines.length) {
      const child = lines[i + 1]!;
      if (child.trim() !== "" && indentOf(child) <= blockIndent) break;
      if (child.trim() === "" && indentOf(lines[i + 2] ?? "") <= blockIndent) break;
      i += 1;
    }
    replacements.push({ site: "lockfile.stale-resolution-removed", before: key, after: "" });
  }

  return kept.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceFirstCapture(
  text: string,
  pattern: RegExp,
  target: string,
  site: string,
  replacements: Replacement[],
): string {
  const match = pattern.exec(text);
  if (!match?.[2]) throw new Error(`could not find ${site}`);
  const before = match[2];
  if (before === target) return text;
  replacements.push({ site, before, after: target });
  return `${text.slice(0, match.index)}${match[1]}${target}${match[3]}${text.slice(match.index + match[0].length)}`;
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function toonVersion(version: string): CatalogToonVersion {
  if (!SEMVER.test(version)) throw new Error(`target version must be x.y.z, got ${version}`);
  return { packageName: "@reddb-io/toon", version, tag: `v${version}` };
}

function parseToonBumpArgs(args: readonly string[]): ParsedToonBumpArgs {
  // The watcher runs this verb as `pnpm -C apps/dev dev toon-bump`, so the cwd is the package, not
  // the workspace. Walk up to the pnpm-workspace.yaml that owns the catalog instead of assuming it.
  let rootDir = findWorkspaceRoot();
  let targetVersion = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--root") {
      rootDir = requiredValue(args[++i], "--root");
      continue;
    }
    if (arg.startsWith("--root=")) {
      rootDir = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--target") {
      targetVersion = requiredValue(args[++i], "--target");
      continue;
    }
    if (arg.startsWith("--target=")) {
      targetVersion = arg.slice("--target=".length);
      continue;
    }
    if (!arg.startsWith("-") && !targetVersion) {
      targetVersion = arg;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!targetVersion) throw new Error("toon-bump requires a target version");
  return { rootDir: resolve(rootDir), targetVersion, dryRun };
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
