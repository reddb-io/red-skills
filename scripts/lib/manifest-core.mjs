// Shared helpers for generate-codex-manifests.mjs, generate-pi-manifests.mjs,
// and build-pi-packages.mjs. Single source of truth — import from here instead
// of duplicating.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export function parseArgs(argv) {
  const args = { root: process.cwd(), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--root") {
      const next = argv[index + 1];
      if (!next) throw new Error("--root requires a path");
      args.root = next;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function titleCaseName(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function normalizeSkillEntry(entry) {
  return String(entry).replace(/\/+$/, "");
}

// Sanitize unicode smart quotes, dashes, and ellipses so generated JSON
// serialises cleanly in any terminal and across manifest formats.
export function normalizeText(input) {
  return String(input ?? "")
    .replace(/[`‘’]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

export function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeGenerated(path, bytes, check, mismatches) {
  if (!check) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return;
  }

  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = "";
  }

  if (current !== bytes) {
    mismatches.push({ path, bytes });
  }
}

// Print git diffs for mismatched generated files. `tempLabel` customises the
// temp-dir prefix so error output identifies which generator produced it.
// Mismatches with a `note` string array are printed as plain text (used by
// build-pi-packages for directory-tree diffs that have no single file to diff).
export async function printDiffs(root, mismatches, { tempLabel = "red-skills-diff-" } = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), tempLabel));
  try {
    for (const mismatch of mismatches) {
      if (mismatch.note) {
        console.error(`# ${relative(root, mismatch.path)}\n${mismatch.note.join("\n")}`);
        continue;
      }
      const rel = relative(root, mismatch.path);
      const expected = join(tempRoot, rel);
      await mkdir(dirname(expected), { recursive: true });
      await writeFile(expected, mismatch.bytes);
      const diff = spawnSync("git", ["diff", "--no-index", "--", mismatch.path, expected], {
        encoding: "utf8",
      });
      const output = `${diff.stdout}${diff.stderr}`.trim();
      if (output) console.error(output);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
