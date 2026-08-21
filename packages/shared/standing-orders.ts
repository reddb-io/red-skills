// standing-orders — the durable maintainer directives every Worker inherits,
// and the one section shape both carriers emit (Spec #4129, Ticket #4141).
//
// ## The decay this closes
//
// Every respawn rebuilds the brief from the tracker. An instruction the
// maintainer gave once — "never touch the generated manifests by hand", "this
// repo lands through the daemon, not `git push`" — lived in the chat that is
// gone by the next Worker, so the only way to keep it was to say it again. A
// directive that survives exactly one process is not a directive; it is a
// reminder with a half-life.
//
// ## Two carriers, one section
//
// Standing orders reach a Worker through two channels, and the whole point of
// this module is that the Worker cannot tell them apart:
//
//   1. **The durable file.** `.red/STANDING-ORDERS.md` in the project's own
//      tree — git-tracked, reviewed like any other file, read at every handoff
//      composition. This is the maintainer's permanent register.
//   2. **The daemon's drain-scoped register.** The append-only, numbered
//      orders `standing_orders_append` writes (ADR 0156), carried to the native
//      Worker as the handoff's own `standing_orders` field rather than spliced
//      into the brief where the brief contract would have to lint them.
//
// Both render through {@link buildStandingOrdersSection}, so the exit protocol
// can name ONE block — `<standing-orders>` — and mean either.
//
// ## Why the orders are never sourced from the Issue
//
// An Issue body is external GitHub content: the handoff marks it
// `data-untrusted="true"` and the exit protocol tells the agent not to obey it
// (ADR 0073). Standing orders are the opposite — they are the operator's own
// words and they DO carry authority. Sourcing them from a place any GitHub
// account can write would hand that authority to a stranger, so the two
// sources here are the ones the operator controls: a file in the repository,
// and a register only the daemon's own tool writes.
//
// PURE: text in, text out. The file read is the caller's, injected as a
// reader, because this module is imported by the wire, the engine and the
// runtime alike.

import { join } from "node:path";

import { redDir } from "./red-paths.js";

/** The durable standing-orders file's name inside a project's `.red/` tree. */
export const STANDING_ORDERS_BASENAME = "STANDING-ORDERS.md";

/** The project-relative path of the durable standing-orders file, for docs and messages. */
export const STANDING_ORDERS_FILE = `.red/${STANDING_ORDERS_BASENAME}`;

/**
 * The config key that switches the durable file off: written as
 * `plugins.dev.afk.standing_orders.enabled` in `.red/config.yaml` and folded to
 * this accessor spelling by the loader (ADR 0042).
 *
 * Deliberately NOT a `CONFIG_DEFAULTS` entry. That table requires a non-empty
 * default for every key it names, which states the answer for a repository that
 * never spoke; this key's answer for silence is "read the file if there is
 * one", and the only value that means anything is the explicit `false`. It
 * follows `dev.lock.branch`, the other key whose natural default is unset.
 */
export const STANDING_ORDERS_ENABLED_KEY = "afk.standing_orders.enabled";

/** The absolute path of a project's durable standing-orders file. */
export function standingOrdersFilePath(repoRoot: string): string {
  return join(redDir(repoRoot), STANDING_ORDERS_BASENAME);
}

/** The handoff section standing orders are emitted in, named by the exit protocol. */
export const STANDING_ORDERS_TAG = "standing-orders";

/**
 * Whether the durable file is read for this project.
 *
 * DEFAULT ON, refused only by the literal `false` — the same comparison every
 * other `afk.*` boolean uses. A repository with no file and no key sees no
 * section either way, so defaulting on costs an absent read and buys the
 * maintainer a working feature the moment they write the file.
 */
export function standingOrdersEnabled(raw: string | undefined): boolean {
  return raw !== "false";
}

/**
 * The orders a source states, or `undefined` when it states none.
 *
 * A file that exists but holds only whitespace is the same as no file: an
 * empty section teaches an agent that the block is decoration.
 */
export function normalizeStandingOrders(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const trimmed = text.replace(/\s+$/, "").replace(/^\n+/, "");
  return trimmed.trim() === "" ? undefined : trimmed;
}

/**
 * The `<standing-orders>` block, VERBATIM, or "" when there are no orders.
 *
 * Verbatim is the contract: the maintainer wrote these words, and a composer
 * that summarised, reordered or renumbered them would be editing an
 * instruction it was asked to carry.
 */
export function buildStandingOrdersSection(text: string | undefined): string {
  const orders = normalizeStandingOrders(text);
  if (orders === undefined) return "";
  return `<${STANDING_ORDERS_TAG}>\n${orders}\n</${STANDING_ORDERS_TAG}>`;
}

/**
 * A brief with its standing orders in front of it, or the brief unchanged.
 *
 * FIRST, not last: an order the agent reads after the task is an order it
 * reads after it has already decided how to do the task.
 */
export function briefWithStandingOrders(text: string | undefined, brief: string): string {
  const section = buildStandingOrdersSection(text);
  return section === "" ? brief : `${section}\n\n${brief}`;
}

/**
 * Read the durable file for a project, honouring the config key.
 *
 * The reader is injected — a path to text, `undefined` when it does not exist —
 * so the decision (is it enabled? does it say anything?) is testable without a
 * filesystem, and so this module reaches no `node:fs` the wire would have to
 * carry.
 */
export function readStandingOrdersFile(input: {
  readonly repoRoot: string;
  readonly enabled: string | undefined;
  readonly read: (path: string) => string | undefined;
}): string | undefined {
  if (!standingOrdersEnabled(input.enabled)) return undefined;
  return normalizeStandingOrders(input.read(standingOrdersFilePath(input.repoRoot)));
}
