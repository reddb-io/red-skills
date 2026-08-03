/**
 * Host configuration for the one daemon that owns machine-wide policy.
 *
 * This reader is intentionally rooted at the operator's home, never at a
 * checkout. A repository may ask the daemon for Workers; it may not redefine
 * the limit shared by every repository on the machine.
 */
import { readFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import {
  resolveHostCeiling,
  type RedskilledHostCeiling,
  type RedskilledHostSettingSource,
} from "./admission.js";
import { DEFAULT_REDSKILLED_IDLE_MS } from "./daemon.js";

export const REDSKILLED_IDLE_MS_ENV = "REDSKILLED_IDLE_MS";
export const REDSKILLED_HOST_CONFIG_PATH = ".red/config.yaml";

export interface RedskilledHostConfig {
  readonly workerCeiling?: string;
  readonly memoryCeiling?: string;
  readonly idleMs?: string;
}

export interface RedskilledHostSettingFlags {
  readonly workerCeiling?: string;
  readonly memoryCeiling?: string;
  readonly idleMs?: number;
}

export interface RedskilledHostSettings {
  readonly ceiling: RedskilledHostCeiling;
  readonly idleMs: number;
  readonly idleMsSource: RedskilledHostSettingSource;
}

/** Read `plugins.dev.redskilled` from the operator's host file. */
export async function readRedskilledHostConfig(
  homeDir: string = homedir(),
): Promise<RedskilledHostConfig> {
  const path = join(homeDir, REDSKILLED_HOST_CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    warn(`redskilled: cannot read host config ${JSON.stringify(path)}; using environment and defaults instead: ${errorMessage(error)}`);
    return {};
  }

  try {
    const values = parseScalarYaml(text);
    return {
      ...valueAt(values, "plugins.dev.redskilled.worker_ceiling", "workerCeiling"),
      ...valueAt(values, "plugins.dev.redskilled.memory_ceiling", "memoryCeiling"),
      ...valueAt(values, "plugins.dev.redskilled.idle_ms", "idleMs"),
    };
  } catch (error) {
    // The same resilience rule as malformed ceiling values: report the broken
    // declaration, but do not turn a typo into a host-wide outage.
    warn(`redskilled: malformed host config ${JSON.stringify(path)}; using environment and defaults instead: ${errorMessage(error)}`);
    return {};
  }
}

/** Resolve every daemon-owned setting under one explicit precedence table. */
export function resolveRedskilledHostSettings(input: {
  readonly flags?: RedskilledHostSettingFlags;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: RedskilledHostConfig;
  readonly totalMemoryBytes?: number;
} = {}): RedskilledHostSettings {
  const env = input.env ?? process.env;
  const config = input.config ?? {};
  const ceiling = resolveHostCeiling(env, input.totalMemoryBytes ?? totalmem(), {
    flags: input.flags,
    config,
  });
  const idle = select(input.flags?.idleMs == null ? undefined : String(input.flags.idleMs), env[REDSKILLED_IDLE_MS_ENV], config.idleMs);
  if (idle == null) {
    return { ceiling, idleMs: DEFAULT_REDSKILLED_IDLE_MS, idleMsSource: "derived-default" };
  }
  const parsed = Number(idle.value);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return { ceiling, idleMs: parsed, idleMsSource: idle.source };
  }
  warn(
    `redskilled: ${describeSource(idle.source)} idle_ms=${JSON.stringify(idle.value)} is not a positive integer; ` +
      `using the default ${DEFAULT_REDSKILLED_IDLE_MS}ms instead.`,
  );
  return { ceiling, idleMs: DEFAULT_REDSKILLED_IDLE_MS, idleMsSource: "derived-default" };
}

function select(
  flag: string | undefined,
  environment: string | undefined,
  config: string | undefined,
): { value: string; source: RedskilledHostSettingSource } | undefined {
  if (flag !== undefined) return { value: flag.trim(), source: "flag" };
  if (environment !== undefined) return { value: environment.trim(), source: "environment" };
  if (config !== undefined) return { value: config.trim(), source: "home-config" };
  return undefined;
}

function valueAt<K extends keyof RedskilledHostConfig>(
  values: Readonly<Record<string, string>>,
  path: string,
  key: K,
): Pick<RedskilledHostConfig, K> | Record<never, never> {
  const value = values[path];
  return value === undefined ? {} : { [key]: value } as Pick<RedskilledHostConfig, K>;
}

/** A deliberately small mapping/scalar YAML reader matching `.red/config.yaml`. */
function parseScalarYaml(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const parents: string[] = [];
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const withoutComment = stripComment(original);
    if (withoutComment.trim() === "") continue;
    const indentation = withoutComment.match(/^ */)?.[0].length ?? 0;
    if (indentation % 2 !== 0 || /\t/.test(withoutComment.slice(0, indentation))) {
      throw new Error(`line ${index + 1} has unsupported indentation`);
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(withoutComment.slice(indentation).trimEnd());
    if (match == null) throw new Error(`line ${index + 1} is not a mapping entry`);
    const depth = indentation / 2;
    if (depth > parents.length) throw new Error(`line ${index + 1} skips a mapping level`);
    parents.splice(depth);
    const key = match[1]!;
    const raw = match[2] ?? "";
    if (raw === "") {
      parents.push(key);
      continue;
    }
    values[[...parents, key].join(".")] = unquote(raw.trim());
  }
  return values;
}

function stripComment(line: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote == null && (character === "'" || character === '"')) quote = character;
    else if (quote === character) quote = undefined;
    else if (quote == null && character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) {
      return line.slice(0, index).trimEnd();
    }
  }
  if (quote != null) throw new Error("unclosed quoted scalar");
  return line;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function describeSource(source: RedskilledHostSettingSource): string {
  if (source === "flag") return "serve flag";
  if (source === "environment") return "environment";
  if (source === "home-config") return "home config";
  return "derived default";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}
