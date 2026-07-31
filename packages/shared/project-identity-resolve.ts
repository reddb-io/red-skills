/**
 * project-identity-resolve.ts — the ONE place a directory becomes a project label.
 *
 * `project-identity.ts` holds the DECISION and stays pure: it reads no file, no
 * environment and no git process, so the rule "declared, else the remote's
 * `owner/repo`, else the checkout basename" is testable as a table. This module
 * is the collection half — the git calls and the config read that feed it.
 *
 * **The two halves are separate files; the label has ONE authority.** They were
 * separate functions in two apps before #2928, and the drift was invisible until
 * it mattered: the birth path resolved a label through the full order while the
 * statusline read only the declared name, so a repository that declared none
 * asked the daemon about a project the daemon had never heard of and read back an
 * idle zero from a host holding three of its Workers. A second resolver is not a
 * second implementation of a rule — it is a second answer to "where am I".
 *
 * **A git call that fails contributes nothing rather than aborting.** A checkout
 * with no git, no remote and no declared name still resolves to a stable label:
 * an unlabelled Worker is worse than one labelled by its directory, and a
 * statusline that threw because `git` was missing would be a blank line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findUp } from "./plugin-gate.js";
import {
  declaredProjectNameInConfig,
  resolveProjectIdentity,
  type ProjectIdentity,
} from "./project-identity.js";

/**
 * How long one `git` call may take before it is treated as absent.
 *
 * Bounded because this runs in a statusline's render path: a `git` that hangs on
 * a stale network mount must cost the label, never the line.
 */
const GIT_TIMEOUT_MS = 2_000;

/**
 * This checkout's project label — the one opaque string the daemon keys a
 * project by (ADR 0130 rule 11).
 *
 * `dir` may be the checkout root or any directory inside it; the config is found
 * upward and git answers from wherever it is asked.
 */
export function resolveProjectLabelForDir(dir: string): string {
  return resolveProjectIdentityForDir(dir).name;
}

/** The full identity, for a caller that needs the slug as well as the name. */
export function resolveProjectIdentityForDir(dir: string): ProjectIdentity {
  const declared = readDeclaredProjectName(dir);
  const gitCommonDir = gitOutput(dir, ["rev-parse", "--absolute-git-dir"]) ??
    gitOutput(dir, ["rev-parse", "--git-common-dir"]);
  const remoteUrl = gitOutput(dir, ["remote", "get-url", "origin"]);
  return resolveProjectIdentity({
    // The config's own repository root when there is one, so a session sitting
    // three directories deep does not fall back to the basename of the directory
    // it happens to be standing in.
    checkoutPath: declared.root ?? dir,
    ...(gitCommonDir !== undefined ? { gitCommonDir } : {}),
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    ...(declared.name !== undefined ? { declaredName: declared.name } : {}),
  });
}

/**
 * The declared name, the config that held it, and the root that owns it.
 *
 * The TEXT is returned alongside the name because the caller that wants the
 * label usually wants the rest of that file too — statusline taste lives in it —
 * and reading it twice is how one read of a file becomes two answers.
 */
export interface DeclaredProjectName {
  /** A declared root-level `project.name`, when the file sets one. */
  readonly name?: string;
  /** The text of the nearest `.red/config.yaml`; absent when there is none. */
  readonly configText?: string;
  /** The directory holding that `.red/`; absent when no config was found. */
  readonly root?: string;
}

/** The nearest `.red/config.yaml` above `dir`, and what it declares. */
export function readDeclaredProjectName(dir: string): DeclaredProjectName {
  const path = findUp(dir, join(".red", "config.yaml"));
  if (path == null) return {};
  let configText: string;
  try {
    configText = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const name = declaredProjectNameInConfig(configText);
  // `<root>/.red/config.yaml` → `<root>`: two levels up, never a string split,
  // so a Windows path resolves the same way a POSIX one does.
  const root = dirname(dirname(path));
  return { ...(name === undefined ? {} : { name }), configText, root };
}

function gitOutput(cwd: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}
