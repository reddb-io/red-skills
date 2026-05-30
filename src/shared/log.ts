// Zero-dependency leveled logger shared across RedSkills domains.
//
// Why not pino / @tetis-lair/tetis-logger (the org standard)? Those pull worker
// threads + sonic-boom, which esbuild bundles poorly and would add hundreds of KB
// to every plugin bundle — and the per-plugin bundle size is a hard constraint
// (ADR 0034). This is the same `createLogger({ serviceName, level })` ergonomic
// surface, implemented in ~1 KB of dependency-free code: pretty + coloured in dev,
// single-line JSON in prod. For AFK's append-only forensic lanes use jsonl-log.ts;
// this is for human-facing diagnostic logging.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  serviceName: string;
  /** Minimum level emitted. Default: "debug" in dev, "info" in prod. */
  level?: LogLevel;
  /** Pretty (dev) vs JSON (prod). Default: pretty unless NODE_ENV==="production". */
  pretty?: boolean;
  /** Sink for one finished line. Default: stderr (so stdout stays machine-clean). */
  write?: (line: string) => void;
  /** Injected clock for deterministic tests; default Date.now via toISOString. */
  now?: () => string;
  bindings?: Record<string, unknown>;
}

const COLOR: Record<LogLevel, string> = { debug: "\x1b[2m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

/** Pull the message + a structured object out of pino-style (obj, msg) | (msg) args. */
function normalize(
  a: Record<string, unknown> | string,
  b?: string,
): { msg: string; fields: Record<string, unknown> } {
  if (typeof a === "string") return { msg: a, fields: {} };
  const fields = { ...a };
  const msg = typeof b === "string" ? b : "";
  // Serialize an `err`/`error` Error to {message, stack} (pino's err serializer).
  for (const k of ["err", "error"] as const) {
    const v = fields[k];
    if (v instanceof Error) fields[k] = { message: v.message, stack: v.stack };
  }
  return { msg, fields };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const isProd = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === "production";
  const level = options.level ?? (isProd ? "info" : "debug");
  const pretty = options.pretty ?? !isProd;
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  const base = { service: options.serviceName, ...(options.bindings ?? {}) };
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, a: Record<string, unknown> | string, b?: string): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const ts = now();
    const { msg, fields } = normalize(a, b);
    const record = { ...base, ...fields };
    if (pretty) {
      const extra = Object.keys(record).length ? ` ${JSON.stringify(record)}` : "";
      write(`${COLOR[lvl]}${ts} ${lvl.toUpperCase().padEnd(5)}${RESET} ${msg}${extra}`);
    } else {
      write(JSON.stringify({ ts, level: lvl, msg, ...record }));
    }
  };

  return {
    debug: (a, b) => emit("debug", a, b),
    info: (a, b) => emit("info", a, b),
    warn: (a, b) => emit("warn", a, b),
    error: (a, b) => emit("error", a, b),
    child: (bindings) => createLogger({ ...options, level, pretty, bindings: { ...base, ...bindings } }),
  };
}
