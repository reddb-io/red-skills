import { createHash } from "node:crypto";
import { flatConfigValue } from "./plugin-gate.js";

/**
 * project-identity.ts — one identity per project, resolved once (Spec #2772).
 *
 * A project has two names and they are not the same thing:
 *   - `name` is what a human reads. It resolves from a declared `project.name`,
 *     then the git remote's `owner/repo`, then the checkout basename.
 *   - `slug` is what the filesystem uses. It is the slugified name plus a short
 *     hash of the absolute git common directory, ALWAYS present.
 *
 * The hash is unconditional on purpose. Detecting a collision first is racy —
 * two clients may not see each other's directories at the same instant, so a
 * collision-only suffix fails in exactly the case it exists for.
 *
 * Hashing the git *common* directory rather than the checkout has a second
 * effect that is wanted, not incidental: every worktree of a repository collapses
 * onto the project its main checkout owns, which is the correct owner for a
 * Worker running inside one.
 *
 * A generated `project.id` written back into config was considered and rejected:
 * the config file is versioned, so a clone would inherit the id and recreate the
 * very collision it was meant to prevent.
 *
 * The resolver is PURE over its inputs — it reads no filesystem, no environment
 * and no git process. Callers collect `remoteUrl` and `gitCommonDir` and hand
 * them in, so the decision itself stays testable as a table.
 */

/**
 * The sanctioned root-level config key holding the declared display name.
 *
 * The config ROOT is right here rather than a leak: identity is shared by the
 * dev, memory and brain plugins in one repository, so it belongs to none of
 * them. Because the loader treats an unsanctioned root key as off-contract, the
 * sanction is explicit — see `SANCTIONED_ROOT_CONFIG_KEYS` in
 * `apps/dev/src/core/config.ts`.
 */
export const PROJECT_NAME_CONFIG_KEY = "project.name";

/**
 * Read the declared `project.name` from the TEXT of a `.red/config.yaml`.
 *
 * Deliberately independent of any plugin's activation gate: a memory-only or
 * brain-only repository declares its identity the same way a dev one does.
 * Returns `undefined` when the key is absent or blank.
 */
export function declaredProjectNameInConfig(text: string): string | undefined {
  const value = flatConfigValue(text, PROJECT_NAME_CONFIG_KEY)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Where the resolved display name came from. */
export type ProjectNameSource = "declared" | "remote" | "basename";

export interface ProjectIdentityInput {
  /** Absolute path of the checkout being resolved — a main checkout or a worktree. */
  readonly checkoutPath: string;
  /**
   * Absolute path of the git common directory (`git rev-parse --git-common-dir`).
   * A worktree reports its MAIN checkout's `.git`, which is what collapses the
   * worktree onto its owning project. Absent outside a git checkout.
   */
  readonly gitCommonDir?: string;
  /** The `origin` remote URL, when the checkout has one. */
  readonly remoteUrl?: string;
  /** A declared root-level `project.name` from `.red/config.yaml`, when set. */
  readonly declaredName?: string;
}

export interface ProjectIdentity {
  /** The display name — declared, else `owner/repo`, else the checkout basename. */
  readonly name: string;
  /** The filesystem slug — `<slugified-name>-<hash>`, the hash always present. */
  readonly slug: string;
  /** The short hash of the git common directory (or the checkout path without one). */
  readonly hash: string;
  /** Which rung of the resolution order produced {@link name}. */
  readonly source: ProjectNameSource;
}

/** Hash width. Eight hex characters keep the slug readable while leaving ~4e9
 * values — far past the number of checkouts one machine will ever hold. */
const HASH_LENGTH = 8;

/** The slug when a name slugifies to nothing at all (e.g. `!!!`). */
const SLUG_FALLBACK = "project";

export function resolveProjectIdentity(input: ProjectIdentityInput): ProjectIdentity {
  const commonDir = normalizeDir(input.gitCommonDir);
  const declared = (input.declaredName ?? "").trim();

  const resolved = declared !== ""
    ? { name: declared, source: "declared" as const }
    : remoteName(input.remoteUrl) ?? { name: checkoutName(input.checkoutPath, commonDir), source: "basename" as const };

  const hash = shortHash(commonDir ?? normalizePath(input.checkoutPath));
  return { name: resolved.name, slug: `${slugify(resolved.name)}-${hash}`, hash, source: resolved.source };
}

/** `owner/repo` from a remote URL, in every spelling git accepts: scp-style
 * (`git@host:owner/repo.git`), `https://`, and `ssh://` with an optional port.
 * Nested groups keep the last two segments, which is the pair that identifies
 * the repository to a human.
 *
 * Exported because the label is not the only thing this pair answers: a project
 * registering with the host states which TRACKER holds its queue, and a second
 * parser for the same URL would be a second answer to "which repository is this"
 * — the drift #2928 was about, in a new place. PURE. */
export function repoSlugFromRemoteUrl(remoteUrl: string | undefined): string | undefined {
  const raw = (remoteUrl ?? "").trim();
  if (raw === "") return undefined;

  const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  // scp-style `host:owner/repo` — the colon is a path separator, not a port.
  const scp = /^[^/]*?:(?!\d)(.+)$/.exec(withoutScheme);
  const afterHost = scp ? scp[1]! : withoutScheme.replace(/^[^/]*/, "");

  const segments = afterHost
    .replace(/\.git$/, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length === 0) return undefined;

  return segments.slice(-2).join("/");
}

function remoteName(remoteUrl: string | undefined): { name: string; source: ProjectNameSource } | undefined {
  const name = repoSlugFromRemoteUrl(remoteUrl);
  return name === undefined ? undefined : { name, source: "remote" };
}

/** The basename fallback. Prefer the MAIN checkout's directory name (the parent
 * of the git common directory) so a worktree does not report itself — a worktree
 * is not a separate project. */
function checkoutName(checkoutPath: string, commonDir: string | undefined): string {
  const fromCommonDir = commonDir === undefined ? "" : baseName(parentName(commonDir));
  if (fromCommonDir !== "") return fromCommonDir;
  const fromCheckout = baseName(normalizePath(checkoutPath));
  return fromCheckout === "" ? SLUG_FALLBACK : fromCheckout;
}

/** Lowercase, path separators become `--`, every other run of non-alphanumerics
 * becomes a single `-`. `reddb-io/red-skills` → `reddb-io--red-skills`. */
function slugify(name: string): string {
  const segments = name
    .split("/")
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((segment) => segment !== "");
  const slug = segments.join("--");
  return slug === "" ? SLUG_FALLBACK : slug;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function normalizeDir(dir: string | undefined): string | undefined {
  const normalized = normalizePath(dir ?? "");
  return normalized === "" ? undefined : normalized;
}

/** Backslashes fold to `/` and a trailing separator is dropped, so the same
 * directory spelled two ways hashes to one value. Deliberately NOT `path.resolve`:
 * resolving would consult `process.cwd()` and break purity. */
function normalizePath(value: string): string {
  const unified = value.trim().replace(/\\/g, "/");
  return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
}

function baseName(value: string): string {
  const segments = value.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "";
}

function parentName(value: string): string {
  const segments = value.split("/").filter((segment) => segment !== "");
  return segments.slice(0, -1).join("/");
}
