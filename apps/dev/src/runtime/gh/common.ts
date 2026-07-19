import { execTool, type ExecOptions, type ExecFn, type ExecOutput } from "../exec.js";

export interface GhContext {
  /** owner/repo slug for `gh ... --repo`. */
  repo: string;
  /** Working dir gh runs from (the primary checkout). */
  cwd: string;
  /**
   * Optional injected exec boundary. Unset in production (the real `execTool`
   * via the `gh` helper runs). Set in tests to a recording fake so the REAL gh
   * closure assembly can be driven without touching the OS. See exec.ts::ExecFn.
   */
  exec?: ExecFn;
}

function opts(ctx: GhContext): ExecOptions {
  return { cwd: ctx.cwd };
}

/**
 * Dispatch a `gh <args>` invocation through the injected exec when present, else
 * the real `gh` helper. This is the single seam every gh closure in this module
 * routes through; the default path is byte-for-byte the prior static `gh` call.
 */
export function runGh(ctx: GhContext, args: readonly string[]): Promise<ExecOutput> {
  return (ctx.exec ?? execTool)("gh", args, opts(ctx));
}

export function runRsp(ctx: GhContext, args: readonly string[]): Promise<ExecOutput> {
  return (ctx.exec ?? execTool)("rsp", args, opts(ctx));
}

export function repoArgs(ctx: GhContext): string[] {
  return ctx.repo ? ["--repo", ctx.repo] : [];
}

export function apiPath(ctx: GhContext, suffix: string): string {
  // ctx.repo is `owner/repo`; fall back to the cwd repo when unset (gh resolves).
  return ctx.repo ? `repos/${ctx.repo}/${suffix}` : suffix;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
