// statusline-native — best-effort host compilation of the native front (ADR 0157).
//
// `redskilled unit install` calls this after the unit lands. Everything here is
// OPTIONAL by construction: no clang, no npx, a scriptc regression, a timeout —
// the install succeeds without the binary and the published statusline command
// degrades to the lean bundle it was already using. The outcome is returned as
// facts, never thrown, so the operator can read WHY a host has no native front.
import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { STATUSLINE_NATIVE_SOURCE } from "./statusline-native-source.js";

/**
 * The compiler, pinned. An ambient `@latest` would make the unit install the
 * one place in the product that runs unreviewed upstream code; bumping this is
 * an ordinary reviewed change.
 */
export const SCRIPTC_PINNED_VERSION = "0.0.35";

/** Where the compiled front lives — the path the published command probes. */
export function statuslineNativeFrontPath(homeDir: string = homedir()): string {
  return join(redskilledHomeDir(homeDir), "bin", "statusline-fast");
}

export interface StatuslineNativeFrontOutcome {
  /** `compiled` | `already-compiled` | `skipped` | `failed` */
  readonly outcome: string;
  /** The one-line reason a human reads; present for every non-`compiled` case. */
  readonly detail?: string;
}

interface CompileIO {
  readonly homeDir?: string;
  readonly run?: (
    command: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ) => Promise<{ ok: boolean; detail?: string }>;
  readonly exists?: (path: string) => Promise<boolean>;
}

const COMPILE_TIMEOUT_MS = 180_000;

/**
 * Compile the embedded source into the daemon home's `bin/`. Best-effort:
 * every failure is an outcome, never a throw.
 */
export async function installStatuslineNativeFront(
  io: CompileIO = {},
): Promise<StatuslineNativeFrontOutcome> {
  const run = io.run ?? defaultRun;
  const homeDir = io.homeDir ?? homedir();
  const target = statuslineNativeFrontPath(homeDir);

  const clang = await run("clang", ["--version"], { timeoutMs: 10_000 });
  if (!clang.ok) {
    return { outcome: "skipped", detail: "no clang on this host — the lean bundle carries the statusline" };
  }

  try {
    const binDir = join(redskilledHomeDir(homeDir), "bin");
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    const source = join(binDir, "statusline-fast.source.mts");
    await writeFile(source, STATUSLINE_NATIVE_SOURCE, { mode: 0o644 });
    const compiled = await run(
      "npx",
      ["-y", `scriptc@${SCRIPTC_PINNED_VERSION}`, "build", source, "-o", target],
      { timeoutMs: COMPILE_TIMEOUT_MS },
    );
    await rm(source, { force: true });
    if (!compiled.ok) {
      return { outcome: "failed", detail: compiled.detail ?? "scriptc build failed" };
    }
    await chmod(target, 0o755);
    return { outcome: "compiled" };
  } catch (error) {
    return { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: options.timeoutMs }, (error, _stdout, stderr) => {
      if (error == null) return resolve({ ok: true });
      const tail = String(stderr ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
      resolve({ ok: false, detail: tail === "" ? error.message : tail });
    });
  });
}
