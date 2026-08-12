// gh/budget-gate-config.ts — where `github.budget_gate` is read from.
//
// The switch itself lives in `@reddb-io/github` (`budget-gate.ts`); this module
// is only the layering, because a library that went looking for a repository's
// `.red/config.yaml` would be a second reader of a document the consumer owns.
//
// **Three layers, most specific first**: the env, then this repository, then the
// operator's host file. The env is a single run's answer, the repository's file
// is the project's, and `~/.red/config.yaml` is the machine's — an operator who
// wants the band everywhere states it once, and a repository that needs it can
// still say so alone.
//
// **Unreadable is `off`.** This is consulted on the path that decides whether
// GitHub gets asked at all, so a malformed YAML file must not be the thing that
// starts refusing an operator's own reads. Every failure resolves to the default.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  GITHUB_BUDGET_GATE_ENV,
  githubBudgetGate,
  type GithubBudgetGateMode,
} from "@reddb-io/github";
import { configFile } from "@reddb-io/shared/red-paths.js";

/** Resolved once per process: this is read per gh call and is a file read. */
let cached: GithubBudgetGateMode | null = null;

/**
 * The mode this process runs under. PURE apart from the two file reads it caches.
 *
 * `root` and `env` are injectable so a test states its own layering rather than
 * writing to the operator's real home directory.
 */
export function resolveGithubBudgetGateMode(options: {
  readonly root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Bypass the process cache; tests that vary the layering need this. */
  readonly fresh?: boolean;
} = {}): GithubBudgetGateMode {
  if (!options.fresh && cached !== null) return cached;
  const env = options.env ?? process.env;
  const declared = env[GITHUB_BUDGET_GATE_ENV];
  const resolved = declared !== undefined && declared.trim() !== ""
    ? githubBudgetGate(declared)
    : githubBudgetGate(
      readDeclaredGate(configFile(options.root ?? process.cwd())) ??
        readDeclaredGate(join(homedir(), ".red", "config.yaml")),
    );
  if (!options.fresh) cached = resolved;
  return resolved;
}

/** Forget the cached mode. For tests, and for a config reload. */
export function forgetGithubBudgetGateMode(): void {
  cached = null;
}

/** The `github.budget_gate` value a config file declares, or `undefined`. */
function readDeclaredGate(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const github = (parsed as Record<string, unknown>).github;
  if (typeof github !== "object" || github === null) return undefined;
  const declared = (github as Record<string, unknown>).budget_gate;
  return declared === undefined ? undefined : declared;
}

export { DEFAULT_GITHUB_BUDGET_GATE } from "@reddb-io/github";
