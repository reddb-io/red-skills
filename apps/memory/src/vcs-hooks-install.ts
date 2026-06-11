import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VcsEvent } from "./vcs-refresh.js";

/**
 * Installer for the git-side auto-update hooks (issue #236). It writes
 * `post-commit` / `post-checkout` scripts into a repo's hooks directory; each
 * script is a self-contained POSIX shell stub that no-ops fast when memory is
 * not initialized and otherwise delegates to `memory vcs refresh`.
 *
 * Opt-in by construction: nothing here runs unless the user invokes
 * `memory vcs install-hooks`. The fs operations take an explicit `hooksDir` so
 * the installer is testable without a real `.git` (the CLI resolves the real
 * dir via `git rev-parse --git-path hooks`).
 */

/** Marker line that identifies a hook script as ours (for safe re-install / uninstall). */
export const HOOK_MARKER = "reddb-memory auto-update hook";

/** The git hooks this installer manages. */
export const MANAGED_HOOKS: readonly VcsEvent[] = ["post-commit", "post-checkout"];

/** Suffix for a backed-up pre-existing hook the installer displaced. */
const BACKUP_SUFFIX = ".pre-memory.bak";

/**
 * Render a hook script. `bootstrapPath` (when provided) is the absolute path to
 * the plugin's `bootstrap.mjs`, embedded as the production delegate. Resolution
 * at hook runtime prefers a `$RED_MEMORY_CLI` override (used by tests/dev), then
 * the embedded bootstrap, then a `memory` on PATH; it exits 0 if none resolves.
 */
export function renderHookScript(event: VcsEvent, bootstrapPath?: string): string {
  const isCheckout = event === "post-checkout";
  const captureArgs = isCheckout ? 'prev="$1"; new_head="$2"; flag="$3"\n' : "";
  const refreshArgs = isCheckout
    ? `vcs refresh --event ${event} --root "$root" --prev "$prev" --new "$new_head" --flag "$flag"`
    : `vcs refresh --event ${event} --root "$root"`;
  // The embedded-bootstrap branch is only emitted when we have a path to embed.
  const bootstrapBranch =
    bootstrapPath && bootstrapPath.length > 0
      ? `elif [ -f ${shQuote(bootstrapPath)} ]; then\n  set -- node ${shQuote(bootstrapPath)}\n`
      : "";
  return `#!/bin/sh
# >>> ${HOOK_MARKER} (${event}) >>>
# Managed by \`memory vcs install-hooks\`. Safe to delete or uninstall with
# \`memory vcs uninstall-hooks\`. Keeps the memory graph fresh via an incremental
# re-ingest/export. No-ops silently when memory is not initialized here.
${captureArgs}root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
# Opt-in gate: a \`plugins.memory\` block in .red/config.yaml (ADR 0042), or the
# legacy .red/memory/config.json (back-compat). No-op when neither is present.
{ [ -f "$root/.red/config.yaml" ] && grep -qE '^[[:space:]]+memory:' "$root/.red/config.yaml"; } || [ -f "$root/.red/memory/config.json" ] || exit 0
if [ -n "$RED_MEMORY_CLI" ]; then
  # shellcheck disable=SC2086
  set -- $RED_MEMORY_CLI
${bootstrapBranch}elif command -v memory >/dev/null 2>&1; then
  set -- memory
else
  exit 0
fi
"$@" ${refreshArgs} >/dev/null 2>&1 || true
exit 0
# <<< ${HOOK_MARKER} (${event}) <<<
`;
}

/** Single-quote a string for safe embedding in the POSIX shell scripts. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface InstallOptions {
  /** Absolute path to the repo's git hooks directory. */
  hooksDir: string;
  /** Absolute path to `bootstrap.mjs` to embed, if known. */
  bootstrapPath?: string;
  /** Overwrite a pre-existing non-managed hook (backing it up first). */
  force?: boolean;
}

export interface InstallResult {
  installed: VcsEvent[];
  skipped: { hook: VcsEvent; reason: string }[];
  backedUp: string[];
}

/**
 * Install the managed hooks into `hooksDir`. A hook we already own is replaced
 * in place. A foreign pre-existing hook is left untouched unless `force`, in
 * which case it is backed up to `<hook>${BACKUP_SUFFIX}` before being replaced.
 */
export async function installGitHooks(opts: InstallOptions): Promise<InstallResult> {
  await mkdir(opts.hooksDir, { recursive: true });
  const result: InstallResult = { installed: [], skipped: [], backedUp: [] };

  for (const hook of MANAGED_HOOKS) {
    const dest = join(opts.hooksDir, hook);
    if (existsSync(dest)) {
      const existing = await readFile(dest, "utf8");
      const ours = existing.includes(HOOK_MARKER);
      if (!ours && !opts.force) {
        result.skipped.push({
          hook,
          reason: `a non-managed ${hook} hook already exists — re-run with --force to back it up and replace it`,
        });
        continue;
      }
      if (!ours && opts.force) {
        const backup = `${dest}${BACKUP_SUFFIX}`;
        await rename(dest, backup);
        result.backedUp.push(backup);
      }
    }
    await writeFile(dest, renderHookScript(hook, opts.bootstrapPath), "utf8");
    await chmod(dest, 0o755);
    result.installed.push(hook);
  }
  return result;
}

export interface UninstallResult {
  removed: VcsEvent[];
  restored: string[];
  skipped: { hook: VcsEvent; reason: string }[];
}

/**
 * Remove the managed hooks from `hooksDir`. Only scripts carrying our marker are
 * removed; a foreign hook is left alone. If a `<hook>${BACKUP_SUFFIX}` exists it
 * is restored into place.
 */
export async function uninstallGitHooks(hooksDir: string): Promise<UninstallResult> {
  const result: UninstallResult = { removed: [], restored: [], skipped: [] };
  for (const hook of MANAGED_HOOKS) {
    const dest = join(hooksDir, hook);
    if (existsSync(dest)) {
      const existing = await readFile(dest, "utf8");
      if (!existing.includes(HOOK_MARKER)) {
        result.skipped.push({ hook, reason: `${hook} is not a managed hook — left untouched` });
        continue;
      }
      await rm(dest, { force: true });
      result.removed.push(hook);
    }
    const backup = `${dest}${BACKUP_SUFFIX}`;
    if (existsSync(backup)) {
      await rename(backup, dest);
      result.restored.push(dest);
    }
  }
  return result;
}
