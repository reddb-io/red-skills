// memory-root — WHICH memory a call reaches, decided once (ADR 0152, ADR 0005).
//
// Memory was local-first per repo: every session in a checkout opened
// `./.red/memory` there, which made the store a property of wherever a process
// happened to stand. Once Workers stopped standing in the human's checkout —
// they run in daemon-placed workspaces (ADR 0149) — "the memory of the repo I
// am in" stopped naming one thing, and ADR 0144 §5 had already refused the
// client checkout as a daemon input.
//
// So the default is the PROJECT's: `~/.red/memory/<project-id>`, keyed by the
// Project's GitHub identity, which survives a clone, a move and a rename. A
// repository may still opt in to its checkout's `./.red/memory` — an operator
// who wants their notes committable is entitled to that — and the daemon opens
// it only for a caller standing in the checkout, which is what the two human
// modes MEAN (ADR 0150 §1).
//
// **The mode is decided before the opt-in is read.** "Never opens the checkout"
// has to include the `.red/config.yaml` that would authorise opening it: a
// resolver that read the opt-in first would touch the human's checkout on every
// Worker call and only then decline to use it, which is the same disk the rule
// exists to keep a Worker off.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { RedskilledMemoryScope } from "@reddb-io/protocol-acp";
import type { WorkingMode } from "@reddb-io/shared/working-mode.js";

import { projectDirectoryName } from "./project-workspace.js";

/** The path segments a memory store hangs off, under a home or a checkout. */
export const MEMORY_ROOT_SEGMENTS = [".red", "memory"] as const;

/** The two modes a human is standing in a checkout for (ADR 0150 §1). */
export const CHECKOUT_MEMORY_MODES: readonly WorkingMode[] = ["interactive", "ADR-editing"];

/** Where this call's memory lives, and why it landed there. */
export interface ResolvedProjectMemoryRoot {
  readonly root: string;
  readonly scope: RedskilledMemoryScope;
  /** One line an operator can read when the answer surprises them. */
  readonly reason: string;
}

/** What a memory call is resolved against. Every field is the daemon's own. */
export interface ProjectMemoryRootRequest {
  /** The Project key, e.g. `github:12345`. Stable across clones and renames. */
  readonly projectId: string;
  /** The checkout this caller bound, as the daemon resolved it from their cwd. */
  readonly checkoutRoot: string;
  /** The user's home directory — where the host-scoped Project stores live. */
  readonly home: string;
  /** The caller's declared Working mode; absent means they export no `RED_MODE`. */
  readonly mode?: WorkingMode | undefined;
  /**
   * Read the repository's opt-in. A FUNCTION rather than a boolean because
   * calling it touches the human's checkout, and the whole point of the rule
   * below is that some calls never do.
   */
  readonly readCheckoutOptIn?: (checkoutRoot: string) => Promise<boolean>;
}

/**
 * Resolve one memory call to one root.
 *
 * The three answers, in the order they are decided:
 *
 *  1. **The caller exports a `RED_MODE` that is a Worker's → the Project's
 *     store.** A `RED_MODE` says a Worker is running (ADR 0150 §2), and a
 *     Worker does not stand in the human's checkout. Decided FIRST, so neither
 *     the store nor the opt-in that would authorise it is ever read.
 *  2. **No opt-in → the Project's store.** The default and the common case:
 *     `~/.red/memory/<project-id>`, one per Project per host.
 *  3. **Opt-in, and a human's mode → the checkout's store.** The caller is a
 *     session standing in the repository that opted in.
 *
 * An absent mode is a human's answer rather than a refusal, because the
 * marker's absence is meaningful (ADR 0150 §2): nobody exports `RED_MODE` in a
 * human's own shell, so demanding one would make the opt-in unreachable.
 */
export async function resolveProjectMemoryRoot(
  request: ProjectMemoryRootRequest,
): Promise<ResolvedProjectMemoryRoot> {
  const projectAnswer = (reason: string): ResolvedProjectMemoryRoot => ({
    root: projectMemoryRoot(request.home, request.projectId),
    scope: "project",
    reason,
  });

  if (request.mode != null && !CHECKOUT_MEMORY_MODES.includes(request.mode)) {
    return projectAnswer(
      `the caller declared RED_MODE=${request.mode}, which is a Worker's mode — ` +
        "a Worker never opens the human checkout's memory",
    );
  }
  const readOptIn = request.readCheckoutOptIn ?? readCheckoutMemoryOptIn;
  if (!(await readOptIn(request.checkoutRoot))) {
    return projectAnswer("this repository did not opt in to a checkout memory store");
  }
  return {
    root: checkoutMemoryRoot(request.checkoutRoot),
    scope: "checkout",
    reason: request.mode == null
      ? "this repository opted in and the caller exports no RED_MODE"
      : `this repository opted in and the caller declared RED_MODE=${request.mode}`,
  };
}

/**
 * The host-scoped store for one Project: `<home>/.red/memory/<project-dir>`.
 *
 * The directory is named exactly as the Project's workspace root is — readable
 * half plus a hash of the whole key — so an operator listing `~/.red/memory`
 * recognises their repositories and two keys that flatten alike stay two
 * directories.
 */
export function projectMemoryRoot(home: string, projectId: string): string {
  return join(resolve(home), ...MEMORY_ROOT_SEGMENTS, projectDirectoryName(projectId));
}

/** The opted-in store inside a human's checkout: `<checkout>/.red/memory`. */
export function checkoutMemoryRoot(checkoutRoot: string): string {
  return join(resolve(checkoutRoot), ...MEMORY_ROOT_SEGMENTS);
}

/** The key a repository spells to keep its memory in its own checkout. */
export const CHECKOUT_MEMORY_OPT_IN_KEY = "plugins.memory.store";

/** The value that key must carry. Anything else — including absence — is off. */
export const CHECKOUT_MEMORY_OPT_IN_VALUE = "checkout";

/**
 * Read a repository's opt-in from its `.red/config.yaml`.
 *
 * Strict opt-in, the same posture plugin activation takes (ADR 0067): an
 * unreadable, absent or malformed config is OFF, because a store that turns on
 * by accident is a store an operator did not choose to keep in their tree.
 */
export async function readCheckoutMemoryOptIn(checkoutRoot: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(resolve(checkoutRoot), ".red", "config.yaml"), "utf8");
  } catch {
    return false;
  }
  try {
    const document = parse(text) as unknown;
    const plugins = field(document, "plugins");
    const memory = field(plugins, "memory");
    return field(memory, "store") === CHECKOUT_MEMORY_OPT_IN_VALUE;
  } catch {
    return false;
  }
}

function field(value: unknown, key: string): unknown {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
