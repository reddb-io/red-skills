// gh/read.ts — the gh JSON read boundary: an ABSENCE of data and a FAILURE to
// obtain data are different outcomes.
//
// **A FAILED QUERY IS NOT AN EMPTY RESULT SET.** Every read in this tree used to
// collapse the two with `if (r.code !== 0) return []`, and an empty result set is
// a confident, well-formed, wrong answer: a `gh pr list` that never ran came back
// as "no pull requests are open" while two were open, and the reader downstream
// concluded the work had merged (#2801). GraphQL makes it worse — an exhausted
// query can exit 0 with a null-filled `data` block and a `RATE_LIMITED` entry in
// `errors`, so even the exit code says nothing.
//
// This module is the single place that decides, so a new consumer inherits the
// distinction instead of the trap. {@link readGhJsonRows} RAISES when the query
// could not run and returns rows — possibly zero of them — only when it did.
// {@link tryReadGhJsonRows} offers the same distinction as a discriminated union
// for callers that must degrade rather than throw. The raised failure carries the
// quota classification from gh/quota.ts, so the bounded wait-and-retry primitive
// already wired through `quotaBackoff` applies rather than a generic failure
// path; this module never retries on its own.

import { githubSurfaceFor, type GithubApiSurface } from "@reddb-io/github";
import { execTool, type ExecFn, type ExecOutput } from "../exec.js";
import { isGhRateLimited, withGhQuotaBackoff, type GhQuotaBackoffOpts } from "./quota.js";

/** Which GitHub API answered (or failed to answer) the read. */
export type GhReadSurface = GithubApiSurface;

/**
 * Why the read produced no usable payload. `quota` is the only TRANSIENT class:
 * the bounded wait-and-retry primitive can still turn it into a real answer.
 */
export type GhReadFailureClass = "quota" | "transport" | "malformed";

/** A read that did not run, or ran and returned something unusable. */
export interface GhReadFailure {
  readonly surface: GhReadSurface;
  readonly classification: GhReadFailureClass;
  /** True only for quota exhaustion — the class a bounded wait can recover. */
  readonly transient: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}

/**
 * The error a raising read throws. Carries the full {@link GhReadFailure} shape
 * so a consumer can branch on `classification` without re-parsing gh output, and
 * so a quota failure reaches the shared quota path rather than a generic one.
 */
export class GhReadError extends Error implements GhReadFailure {
  readonly name = "GhReadError";
  readonly surface: GhReadSurface;
  readonly classification: GhReadFailureClass;
  readonly transient: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(failure: GhReadFailure) {
    super(failure.message);
    this.surface = failure.surface;
    this.classification = failure.classification;
    this.transient = failure.transient;
    this.code = failure.code;
    this.stdout = failure.stdout;
    this.stderr = failure.stderr;
  }
}

/** Either rows the query really returned, or the failure that prevented them. */
export type GhReadResult<T> =
  | { readonly outcome: "rows"; readonly rows: T[] }
  | { readonly outcome: "failed"; readonly failure: GhReadFailure };

/** Either the record the query really returned, or the failure. */
export type GhReadRecordResult =
  | { readonly outcome: "record"; readonly record: Record<string, unknown> }
  | { readonly outcome: "failed"; readonly failure: GhReadFailure };

/**
 * The read boundary's slice of {@link GhContext}: a cwd, the injectable exec, and
 * the optional bounded quota retry. `GhContext` satisfies it structurally, so a
 * gh helper passes its own ctx straight through.
 */
export interface GhReadContext {
  cwd: string;
  exec?: ExecFn;
  quotaBackoff?: GhQuotaBackoffOpts;
}

export interface GhReadOptions {
  /** Max captured stdout bytes; raise it for whole-repo listings. */
  maxBuffer?: number;
}

/**
 * True when `failure` is transient GitHub quota exhaustion, so the caller should
 * wait and retry rather than treat it as a permanent failure. Accepts a
 * {@link GhReadError}, a bare {@link GhReadFailure}, or anything else (false).
 */
export function isGhQuotaExhausted(failure: unknown): boolean {
  if (!failure || typeof failure !== "object") return false;
  const rec = failure as Partial<GhReadFailure>;
  return rec.classification === "quota" && rec.transient === true;
}

/**
 * Which API a `gh` argv reads from — now a ROUTER rather than a label.
 *
 * The decision itself belongs to `@reddb-io/github`, which the daemon and the
 * castle import too: one table, because two implementations of one routing rule
 * drift. This function is the read boundary's door to it, kept exported because
 * consumers name it, and it RAISES on an operation nobody classified. The old
 * body defaulted everything that was not `gh api <path>` to GraphQL, which is
 * how every single-object poll ended up drawing the node-point pool while the
 * request pool sat idle (ADR 0132 decision 4, #3094).
 */
export function ghReadSurface(args: readonly string[]): GhReadSurface {
  return githubSurfaceFor(args);
}

function failureFrom(
  surface: GhReadSurface,
  out: ExecOutput,
  message: string,
  classification?: GhReadFailureClass,
): GhReadFailure {
  const resolved = classification ?? (isGhRateLimited(out) ? "quota" : "transport");
  return {
    surface,
    classification: resolved,
    transient: resolved === "quota",
    code: out.code,
    stdout: out.stdout,
    stderr: out.stderr,
    message,
  };
}

function readFailed(failure: GhReadFailure): { outcome: "failed"; failure: GhReadFailure } {
  return { outcome: "failed", failure };
}

function dispatch(
  ctx: GhReadContext,
  args: readonly string[],
  options?: GhReadOptions,
): Promise<ExecOutput> {
  const fn = () =>
    (ctx.exec ?? execTool)("gh", args, {
      cwd: ctx.cwd,
      ...(options?.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    });
  // The bounded wait-and-retry is the shared primitive's, never this module's.
  return ctx.quotaBackoff ? withGhQuotaBackoff(fn, ctx.quotaBackoff) : fn();
}

function parseRows<T>(surface: GhReadSurface, out: ExecOutput): GhReadResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout.trim() === "" ? "[]" : out.stdout);
  } catch {
    return readFailed(failureFrom(surface, out, "gh read returned malformed JSON", "malformed"));
  }
  if (!Array.isArray(parsed)) {
    return readFailed(failureFrom(surface, out, "gh read returned a non-array payload", "malformed"));
  }
  return { outcome: "rows", rows: parsed as T[] };
}

/**
 * Read a JSON array from `gh <args>` WITHOUT collapsing failure into emptiness.
 * `{outcome: "rows", rows: []}` means the query ran and the repo has nothing;
 * `{outcome: "failed"}` means it never ran. A successful read with empty stdout
 * counts as zero rows.
 */
export async function tryReadGhJsonRows<T>(
  ctx: GhReadContext,
  args: readonly string[],
  options?: GhReadOptions,
): Promise<GhReadResult<T>> {
  // The route is resolved BEFORE the call: an unclassified operation must raise
  // where a human can still name it, not while a failure record is being built.
  const surface = ghReadSurface(args);
  const out = await dispatch(ctx, args, options);
  if (out.code !== 0) return readFailed(failureFrom(surface, out, "gh read failed"));
  return parseRows<T>(surface, out);
}

/**
 * {@link tryReadGhJsonRows}, raising {@link GhReadError} on failure. Use this
 * where an absence would be read as fact: a caller that cannot handle the
 * failure must fail loudly rather than report nothing found.
 */
export async function readGhJsonRows<T>(
  ctx: GhReadContext,
  args: readonly string[],
  options?: GhReadOptions,
): Promise<T[]> {
  const result = await tryReadGhJsonRows<T>(ctx, args, options);
  if (result.outcome === "failed") throw new GhReadError(result.failure);
  return result.rows;
}

function graphqlErrorText(errors: readonly unknown[]): string {
  return errors
    .map((entry) => {
      if (!entry || typeof entry !== "object") return String(entry ?? "");
      const rec = entry as { type?: unknown; message?: unknown };
      return [rec.type, rec.message].filter(Boolean).map(String).join(": ");
    })
    .filter(Boolean)
    .join("; ");
}

/**
 * Read the `data` block of a `gh api graphql` response, treating a non-empty
 * `errors` array as a FAILURE even though gh exited 0. An exhausted GraphQL
 * query answers with null-filled data plus a `RATE_LIMITED` error; reading its
 * `data` at face value is how it renders as "nothing is open".
 */
export async function tryReadGhGraphql(
  ctx: GhReadContext,
  args: readonly string[],
  options?: GhReadOptions,
): Promise<GhReadRecordResult> {
  const surface = ghReadSurface(args);
  const out = await dispatch(ctx, args, options);
  if (out.code !== 0) return readFailed(failureFrom(surface, out, "gh graphql read failed"));

  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout.trim() === "" ? "{}" : out.stdout);
  } catch {
    return readFailed(failureFrom(surface, out, "gh graphql read returned malformed JSON", "malformed"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return readFailed(failureFrom(surface, out, "gh graphql read returned a non-object payload", "malformed"));
  }

  const payload = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const text = graphqlErrorText(payload.errors);
    // Classify against the SAME rate-limit classifier the exit-code path uses,
    // so a RATE_LIMITED payload lands on the quota path either way.
    const classified: ExecOutput = { code: 1, stdout: out.stdout, stderr: text };
    return readFailed(failureFrom(surface, classified, `gh graphql read returned errors: ${text}`));
  }
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    return readFailed(failureFrom(surface, out, "gh graphql read returned no data block", "malformed"));
  }
  return { outcome: "record", record: payload.data as Record<string, unknown> };
}

/** {@link tryReadGhGraphql}, raising {@link GhReadError} on failure. */
export async function readGhGraphql(
  ctx: GhReadContext,
  args: readonly string[],
  options?: GhReadOptions,
): Promise<Record<string, unknown>> {
  const result = await tryReadGhGraphql(ctx, args, options);
  if (result.outcome === "failed") throw new GhReadError(result.failure);
  return result.record;
}
