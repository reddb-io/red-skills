#!/usr/bin/env node
// Pull-request release-entry gate (#3508).
//
// This check deliberately takes the base and head commits from its caller. CI
// owns the pull-request context; deriving either revision from the contributor's
// currently checked-out branch would make the verdict depend on local state.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPABLE_PATH = /^(?:apps|packages)\//;
const RELEASE_ENTRY_PATH = /^\.changeset\/(?!README\.md$)(?!\.)[^/]+\.md$/;
const REVISION = /^[0-9a-f]{7,64}$/i;

function statedExemption(files) {
  if (files.length > 0 && files.every((file) => file === "README.md" || file.startsWith("docs/"))) {
    return "documentation-only exemption";
  }
  if (files.length > 0 && files.every((file) => file.startsWith(".red/"))) return ".red-only exemption";
  if (files.length > 0 && files.every((file) => file.startsWith(".github/workflows/"))) {
    return "workflow-only exemption";
  }
  return "no apps/ or packages/ paths changed";
}

export function releaseEntryVerdict(changedFiles) {
  const files = [...new Set(changedFiles)].sort();
  const shippableFiles = files.filter((file) => SHIPPABLE_PATH.test(file));
  const releaseEntries = files.filter((file) => RELEASE_ENTRY_PATH.test(file));

  if (shippableFiles.length === 0) {
    return {
      ok: true,
      kind: "exempt",
      message: `release entry not required — ${statedExemption(files)}`,
    };
  }

  if (releaseEntries.length > 0) {
    return {
      ok: true,
      kind: "release-entry-present",
      message: `release entry present — ${releaseEntries.join(", ")}`,
    };
  }

  return {
    ok: false,
    kind: "release-entry-required",
    message:
      "apps/ or packages/ changed without a release entry. " +
      "Add `.changeset/<descriptive-name>.md` with changeset-compatible frontmatter " +
      "(run `pnpm changeset`).",
  };
}

function assertRevision(value, flag) {
  if (!REVISION.test(value ?? "")) throw new Error(`${flag} must be an explicit git commit SHA`);
  return value;
}

export function changedFilesBetween(root, base, head) {
  const range = `${assertRevision(base, "--base")}...${assertRevision(head, "--head")}`;
  const output = execFileSync("git", ["-C", root, "diff", "--name-only", "-z", range, "--"]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function run(argv = [], { log = console.log, error = console.error } = {}) {
  let root = REPO_ROOT;
  let base;
  let head;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") root = resolve(argv[++index] ?? "");
    else if (arg === "--base") base = argv[++index];
    else if (arg === "--head") head = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }

  const verdict = releaseEntryVerdict(changedFilesBetween(root, base, head));
  if (verdict.ok) {
    log(verdict.message);
    return 0;
  }

  error(`::error title=Release entry required::${verdict.message}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`::error title=Release entry check failed::${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
