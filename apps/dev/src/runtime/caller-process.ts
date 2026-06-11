// caller-process — best-effort process ancestry string for runner detection.
//
// AFK should default to the runner that invoked it: Claude Code when called
// from Claude Code, Codex when called from Codex. Env/path detection covers
// installed plugin paths, but repo-local bundle execution can be neutral, so we
// also walk the parent process chain and hand the command names to
// runner-detection's process-tree sniff.

import { execFileSync } from "node:child_process";

export interface PsAncestor {
  pid: number;
  ppid: number;
  command: string;
}

export type PsInspector = (pid: number) => string;

export function parsePsAncestorLine(stdout: string): PsAncestor | null {
  const line = stdout.trim();
  if (line.length === 0) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, command: parts.slice(2).join(" ") };
}

export function callerProcessTree(
  startPid: number,
  inspect: PsInspector,
  maxDepth = 12,
): string {
  const commands: string[] = [];
  const seen = new Set<number>();
  let pid = startPid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) break;
    seen.add(pid);
    let raw: string;
    try {
      raw = inspect(pid);
    } catch {
      // Transient ps failure (ETIMEDOUT, EAGAIN, vanished ancestor) — stop
      // the walk rather than propagating; runner detection gets a partial tree.
      break;
    }
    const parsed = parsePsAncestorLine(raw);
    if (!parsed) break;
    if (parsed.command) commands.push(parsed.command);
    pid = parsed.ppid;
  }

  return commands.join("\n");
}

export function callerProcessTreeNative(startPid = process.ppid): string {
  return callerProcessTree(startPid, (pid) =>
    execFileSync("ps", ["-o", "pid=,ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 3000,
    }),
  );
}
