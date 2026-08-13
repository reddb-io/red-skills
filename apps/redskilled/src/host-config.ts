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
import { parse } from "yaml";
import {
  resolveHostCeiling,
  type RedskilledHostCeiling,
  type RedskilledHostSettingSource,
} from "./admission.js";
import { DEFAULT_REDSKILLED_IDLE_MS } from "./daemon.js";
import {
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  type RedskilledPublicHostEventKind,
} from "./event-lane.js";
import type { RedskilledLaunchTemplate } from "./launch-template.js";
import type { RedskilledHostEventSinks } from "./host-event-sink.js";

export const REDSKILLED_IDLE_MS_ENV = "REDSKILLED_IDLE_MS";
export const REDSKILLED_HOST_CONFIG_PATH = ".red/config.yaml";

export interface RedskilledHostConfig {
  readonly workerCeiling?: string;
  readonly memoryCeiling?: string;
  readonly validationCeiling?: string;
  readonly idleMs?: string;
  /** Optional GitHub App payer; validation stays in @reddb-io/github. */
  readonly githubApp?: Readonly<Record<string, unknown>>;
  /** Operator-scoped programs fired for public Worker lifecycle changes. */
  readonly hooks?: Partial<Record<RedskilledPublicHostEventKind, RedskilledLaunchTemplate>>;
  /** Public Worker lifecycle changes also surfaced through the native desktop sink. */
  readonly notifications?: readonly RedskilledPublicHostEventKind[];
}

export interface RedskilledHostSettingFlags {
  readonly workerCeiling?: string;
  readonly memoryCeiling?: string;
  readonly validationCeiling?: string;
  readonly idleMs?: number;
}

export interface RedskilledHostSettings {
  readonly ceiling: RedskilledHostCeiling;
  readonly idleMs: number;
  readonly idleMsSource: RedskilledHostSettingSource;
}

/** Attach persistent operator policy to one daemon invocation. */
export function resolveRedskilledHostEventSinks(
  config: RedskilledHostConfig,
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
): RedskilledHostEventSinks | undefined {
  if (config.hooks == null && config.notifications == null) return undefined;
  return {
    workspacePath,
    ...(config.hooks == null ? {} : { hooks: config.hooks }),
    ...(config.notifications == null ? {} : { notifications: config.notifications }),
    platform,
  };
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
    const document = parse(text) as unknown;
    const redskilled = mappingAt(document, ["plugins", "dev", "redskilled"]);
    return {
      ...scalarAt(redskilled, "worker_ceiling", "workerCeiling"),
      ...scalarAt(redskilled, "memory_ceiling", "memoryCeiling"),
      ...scalarAt(redskilled, "validation_ceiling", "validationCeiling"),
      ...scalarAt(redskilled, "idle_ms", "idleMs"),
      ...mappingPropertyAt(redskilled, "github_app", "githubApp"),
      ...hooksAt(redskilled),
      ...notificationsAt(redskilled),
    };
  } catch (error) {
    // The same resilience rule as malformed ceiling values: report the broken
    // declaration, but do not turn a typo into a host-wide outage.
    warn(`redskilled: malformed host config ${JSON.stringify(path)}; using environment and defaults instead: ${errorMessage(error)}`);
    return {};
  }
}

function mappingPropertyAt<K extends keyof RedskilledHostConfig>(
  values: Readonly<Record<string, unknown>>,
  path: string,
  key: K,
): Pick<RedskilledHostConfig, K> | Record<never, never> {
  const value = values[path];
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new Error(`${path} must be a map`);
  return { [key]: value } as Pick<RedskilledHostConfig, K>;
}

/** Resolve every daemon-owned setting under one explicit precedence table. */
export function resolveRedskilledHostSettings(input: {
  readonly flags?: RedskilledHostSettingFlags;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: RedskilledHostConfig;
  readonly totalMemoryBytes?: number;
  readonly availableParallelism?: number;
} = {}): RedskilledHostSettings {
  const env = input.env ?? process.env;
  const config = input.config ?? {};
  const ceiling = resolveHostCeiling(env, input.totalMemoryBytes ?? totalmem(), {
    flags: input.flags,
    config,
    ...(input.availableParallelism == null ? {} : { availableParallelism: input.availableParallelism }),
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

function scalarAt<K extends keyof RedskilledHostConfig>(
  values: Readonly<Record<string, unknown>>,
  path: string,
  key: K,
): Pick<RedskilledHostConfig, K> | Record<never, never> {
  const value = values[path];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${path} must be a scalar`);
  }
  return { [key]: String(value) } as Pick<RedskilledHostConfig, K>;
}

function mappingAt(value: unknown, path: readonly string[]): Readonly<Record<string, unknown>> {
  let current = value;
  for (const key of path) {
    if (!isMapping(current)) return {};
    current = current[key];
  }
  return isMapping(current) ? current : {};
}

function hooksAt(
  redskilled: Readonly<Record<string, unknown>>,
): Pick<RedskilledHostConfig, "hooks"> | Record<never, never> {
  if (redskilled.hooks == null) return {};
  if (!isMapping(redskilled.hooks)) throw new Error("hooks must be a map keyed by public host event kind");
  const hooks: Partial<Record<RedskilledPublicHostEventKind, RedskilledLaunchTemplate>> = {};
  for (const [kind, declaration] of Object.entries(redskilled.hooks)) {
    if (!isPublicKind(kind)) throw new Error(`unsupported hook event ${JSON.stringify(kind)}`);
    if (!isMapping(declaration) || !Array.isArray(declaration.argv) || declaration.argv.length === 0 ||
      declaration.argv.some((word) => typeof word !== "string")) {
      throw new Error(`hook ${JSON.stringify(kind)} must declare a non-empty string argv`);
    }
    if (declaration.env != null && (!isMapping(declaration.env) ||
      Object.values(declaration.env).some((entry) => typeof entry !== "string"))) {
      throw new Error(`hook ${JSON.stringify(kind)} env must map names to strings`);
    }
    hooks[kind] = {
      argv: declaration.argv as string[],
      ...(declaration.env == null ? {} : { env: declaration.env as Record<string, string> }),
    };
  }
  return Object.keys(hooks).length === 0 ? {} : { hooks };
}

function notificationsAt(
  redskilled: Readonly<Record<string, unknown>>,
): Pick<RedskilledHostConfig, "notifications"> | Record<never, never> {
  if (redskilled.notifications == null) return {};
  if (!Array.isArray(redskilled.notifications) || redskilled.notifications.some((kind) => !isPublicKind(kind))) {
    throw new Error("notifications must list public host event kinds");
  }
  return redskilled.notifications.length === 0
    ? {}
    : { notifications: [...new Set(redskilled.notifications as RedskilledPublicHostEventKind[])] };
}

function isPublicKind(value: unknown): value is RedskilledPublicHostEventKind {
  return typeof value === "string" && REDSKILLED_PUBLIC_HOST_EVENT_KINDS.includes(value as RedskilledPublicHostEventKind);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
