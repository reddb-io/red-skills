import { renderUnknownFlag } from "../structured-error.js";
import type { ParsedArgs } from "./types.js";

export function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function numericValueAfter(args: readonly string[], flag: string): number | undefined {
  const value = valueAfter(args, flag);
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv[0] === "--help" || argv[0] === "-h" || argv.includes("--help") || argv.includes("-h");
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { level: "lossless", positional: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--store-uri") out.storeUri = argv[++i];
    else if (arg === "--brief") out.level = "brief";
    else if (arg === "--terse") out.level = "terse";
    else if (arg === "--query") out.query = argv[++i];
    else if (arg.startsWith("--query=")) out.query = arg.slice("--query=".length);
    else if (positional.length === 0 && arg.startsWith("--")) throw new CliUsageError(arg);
    else positional.push(arg);
  }
  if (out.query && positional[0] !== "show" && !positional.some((arg) => arg === "--query" || arg.startsWith("--query="))) {
    positional.push("--query", out.query);
  }
  out.command = positional[0];
  out.handle = positional[1];
  out.positional = positional;
  return out;
}

export class CliUsageError extends Error {
  constructor(readonly flag: string) {
    super(`unknown flag: ${flag}`);
  }

  render(): Buffer {
    return renderUnknownFlag("rsp", this.flag, ["--store-uri", "--brief", "--terse", "--query"], "rsp --help");
  }
}

export function isStructuredUsageRenderable(err: unknown): err is { render: () => Buffer } {
  return typeof err === "object" && err !== null && "render" in err &&
    typeof (err as { render?: unknown }).render === "function";
}

export function parseGhApiJsonArgs(argv: readonly string[]): { path: string; params: Record<string, string> } | null {
  const path = argv[1];
  if (!path) return null;
  const params: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "-f" && arg !== "-F") continue;
    const assignment = argv[++i] ?? "";
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    params[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return { path, params };
}

export function sinceDays(args: readonly string[], fallback: number): number {
  const raw = valueAfter(args, "--since") ?? args.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
  if (!raw) return fallback;
  const match = /^(\d+)(d)?$/.exec(raw);
  if (!match) return fallback;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : fallback;
}

export function statsFull(args: readonly string[]): boolean {
  return args.includes("--full");
}
