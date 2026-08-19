import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfigValues } from "./config.js";

export const CASTLE_HOOK_NAMES = [
  "supervisor_start",
  "supervisor_exit",
  "fleet_scaled",
  "worker_start",
  "worker_exit",
  "worker_steered",
  "worker_escalated",
  "post_claim",
  "pre_worktree",
  "post_issue",
  "pre_requeue",
  "pre_merge",
  "post_merge",
] as const;

export type CastleHookName = (typeof CASTLE_HOOK_NAMES)[number];
export type CastleHookExitPolicy = "abort" | "continue";

export const CASTLE_HOOK_EXIT_POLICY: Record<
  CastleHookName,
  CastleHookExitPolicy
> = {
  supervisor_start: "abort",
  supervisor_exit: "continue",
  fleet_scaled: "continue",
  worker_start: "abort",
  worker_exit: "continue",
  worker_steered: "continue",
  worker_escalated: "continue",
  post_claim: "continue",
  pre_worktree: "abort",
  post_issue: "continue",
  pre_requeue: "abort",
  pre_merge: "abort",
  post_merge: "continue",
};

export const CASTLE_HOOK_DEFAULTS_REGISTRY = {
  pre_worktree: ["cargo", "gradle"],
} as const satisfies Partial<Record<CastleHookName, readonly string[]>>;

export const CASTLE_HOOK_DEFAULT_NAMES = Object.values(
  CASTLE_HOOK_DEFAULTS_REGISTRY,
).flat();

export type CastleHookDefaultName = (typeof CASTLE_HOOK_DEFAULT_NAMES)[number];

export type ResolvedCastleHooks = Record<CastleHookName, string[]>;
export type CastleHookDefaultResolver = (
  name: CastleHookDefaultName,
) => string | undefined;
export type CastleHookExec = (
  command: string,
  env: Record<string, string>,
  stdinJson: string,
) => Promise<{ code: number; stdout: string }>;

export interface CastleHookExecution {
  readonly name: CastleHookName;
  readonly command: string;
  readonly rc: number;
}

export type CastleHookContext = Record<string, unknown>;

export interface CastleHookDispatchResult {
  readonly context: CastleHookContext;
  readonly aborted: boolean;
  readonly vetoed: boolean;
  readonly rc: number;
  readonly executions: CastleHookExecution[];
}

export interface ResolveCastleHooksOptions {
  readonly libraryHooksDir?: string;
  readonly projectHooksDir?: string;
  readonly projectRoot?: string;
  readonly defaultCommand?: CastleHookDefaultResolver;
  readonly listFiles?: (dir: string) => string[];
  readonly exists?: (path: string) => boolean;
  readonly isFile?: (path: string) => boolean;
  readonly isDirectory?: (path: string) => boolean;
}

export interface DispatchCastleHookOptions {
  readonly env?: Record<string, string>;
  readonly log?: (message: string) => void;
}

export class UnknownCastleHookError extends Error {
  constructor(public readonly hookName: string) {
    super(`unknown castle hook name '${hookName}'`);
    this.name = "UnknownCastleHookError";
  }
}

const HOOK_NAME_SET = new Set<string>(CASTLE_HOOK_NAMES);
const HOOKS_PREFIXES = ["afk.hooks.", "plugins.dev.afk.hooks."] as const;
const DEFAULTS_FRAGMENT = "hooks.defaults.";
const PARSE_FAILURE_RC = 65;

function isCastleHookName(name: string): name is CastleHookName {
  return HOOK_NAME_SET.has(name);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function setEnv(
  env: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    env[key] = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    env[key] = String(value);
  }
}

export function deriveCastleHookEnv(
  base: Record<string, string>,
  context: CastleHookContext,
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  const issue = asObject(context.issue);
  const result = asObject(context.result);
  const error = asObject(context.error);
  const mergeCommit = asObject(context.merge_commit);
  const vitals = asObject(context.vitals);
  const fleet = asObject(context.fleet);
  const steering = asObject(context.steering);
  const escalation = asObject(context.escalation);
  const requeue = asObject(context.requeue);

  setEnv(env, "RED_AFK_ISSUE", issue?.number ?? issue?.id);
  setEnv(env, "RED_AFK_ISSUE_ID", issue?.number ?? issue?.id);
  setEnv(env, "RED_AFK_WORKSPACE", context.workspace);
  setEnv(env, "RED_AFK_RUNNER", context.runner);
  setEnv(env, "RED_AFK_WORKER_ID", context.worker_id);
  setEnv(env, "RED_AFK_SUPERVISOR_ID", context.supervisor_id);
  setEnv(env, "RED_AFK_MERGE_BASE", context.merge_base);

  setEnv(env, "RED_AFK_RESULT_STATUS", result?.status);
  setEnv(env, "RED_AFK_RESULT_OUTCOME", result?.outcome);
  setEnv(env, "RED_AFK_ERROR_CLASS", error?.class);
  setEnv(env, "RED_AFK_ERROR_MESSAGE", error?.message);
  setEnv(env, "RED_AFK_MERGE_COMMIT", mergeCommit?.sha);
  setEnv(env, "RED_AFK_MERGE_SHA", mergeCommit?.short);

  setEnv(env, "RED_AFK_FLEET_TARGET", fleet?.target);
  setEnv(env, "RED_AFK_FLEET_PREVIOUS_TARGET", fleet?.previous_target);
  setEnv(env, "RED_AFK_STEERING_REASON", steering?.reason);
  setEnv(env, "RED_AFK_ESCALATION_REASON", escalation?.reason);
  setEnv(env, "RED_AFK_REQUEUE_REASON", requeue?.reason ?? context.reason);
  setEnv(
    env,
    "RED_AFK_PREV_FAILURE_REASON",
    requeue?.prev_failure_reason ?? context.prev_failure_reason,
  );

  if (vitals) {
    for (const [key, value] of Object.entries(vitals)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        env[`RED_AFK_VITAL_${key.toUpperCase()}`] = String(value);
      }
    }
  }

  return env;
}

function numericPrefix(filename: string): number {
  const match = /^(\d+)/.exec(filename);
  return match ? parseInt(match[1]!, 10) : Infinity;
}

function compareFilenames(a: string, b: string): number {
  const diff = numericPrefix(a) - numericPrefix(b);
  return diff !== 0 ? diff : a.localeCompare(b);
}

function listPointDirScripts(
  point: CastleHookName,
  libraryHooksDir: string | undefined,
  projectHooksDir: string | undefined,
  listFiles: (dir: string) => string[],
  exists: (path: string) => boolean,
  isDirectory: (path: string) => boolean,
): string[] {
  const list = (root: string | undefined): Map<string, string> => {
    const out = new Map<string, string>();
    if (root === undefined) return out;
    const dir = join(root, point);
    if (!exists(dir)) return out;
    if (!isDirectory(dir)) return out;
    let files: string[];
    try {
      files = listFiles(dir);
    } catch {
      return out;
    }
    for (const file of files) {
      if (!file.startsWith(".")) out.set(file, join(dir, file));
    }
    return out;
  };

  const merged = new Map<string, string>([
    ...list(libraryHooksDir),
    ...list(projectHooksDir),
  ]);
  return [...merged.keys()]
    .sort(compareFilenames)
    .map((file) => merged.get(file)!);
}

function flatPointBody(
  point: CastleHookName,
  libraryHooksDir: string | undefined,
  projectHooksDir: string | undefined,
  exists: (path: string) => boolean,
  isFile: (path: string) => boolean,
): string | undefined {
  if (projectHooksDir !== undefined) {
    const project = join(projectHooksDir, point);
    if (exists(project) && isFile(project)) return project;
  }
  if (libraryHooksDir !== undefined) {
    const library = join(libraryHooksDir, point);
    if (exists(library) && isFile(library)) return library;
  }
  return undefined;
}

export function castleHookDefaultResolver(
  libraryHooksDir: string,
  projectHooksDir?: string,
  projectRoot?: string,
  exists: (path: string) => boolean = existsSync,
  listFiles: (dir: string) => string[] = readdirSync,
  isFile: (path: string) => boolean = (path) => statSync(path).isFile(),
): CastleHookDefaultResolver {
  const scripts: Record<CastleHookDefaultName, string> = {
    cargo: "red-cargo",
    gradle: "red-gradle",
  };
  return (name) => {
    if (
      name === "cargo" &&
      projectRoot !== undefined &&
      (!exists(join(projectRoot, "Cargo.toml")) ||
        !isFile(join(projectRoot, "Cargo.toml")))
    ) {
      return undefined;
    }
    if (name === "gradle" && projectRoot !== undefined) {
      let hasGradleBuild = false;
      try {
        hasGradleBuild = listFiles(projectRoot).some(
          (file) =>
            file.startsWith("build.gradle") && isFile(join(projectRoot, file)),
        );
      } catch {
        hasGradleBuild = false;
      }
      if (!hasGradleBuild) return undefined;
    }

    const filename = scripts[name];
    if (projectHooksDir !== undefined) {
      const project = join(projectHooksDir, filename);
      if (exists(project)) return project;
    }
    const library = join(libraryHooksDir, filename);
    return exists(library) ? library : undefined;
  };
}

function collectInlineHookCommands(
  config: EngineConfigValues,
): Map<CastleHookName, string[]> {
  const out = new Map<
    CastleHookName,
    Array<{ index: number; command: string }>
  >();

  for (const [key, value] of Object.entries(config)) {
    const prefix = HOOKS_PREFIXES.find((candidate) =>
      key.startsWith(candidate),
    );
    if (prefix === undefined) continue;
    if (key.includes(DEFAULTS_FRAGMENT)) continue;

    const rawName = key.slice(prefix.length);
    const match = /^([^.]+)(?:\.(\d+))?$/.exec(rawName);
    if (!match) throw new UnknownCastleHookError(rawName);

    const name = match[1]!;
    if (!isCastleHookName(name)) throw new UnknownCastleHookError(name);

    const explicitIndex = match[2] === undefined ? undefined : Number(match[2]);
    const commands = value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const list = out.get(name) ?? [];
    commands.forEach((command, offset) => {
      list.push({
        index:
          explicitIndex === undefined
            ? Number.MAX_SAFE_INTEGER + offset
            : explicitIndex + offset,
        command,
      });
    });
    out.set(name, list);
  }

  return new Map(
    [...out.entries()].map(([name, entries]) => [
      name,
      entries.sort((a, b) => a.index - b.index).map((entry) => entry.command),
    ]),
  );
}

export function resolveCastleHooks(
  config: EngineConfigValues,
  options: ResolveCastleHooksOptions = {},
): ResolvedCastleHooks {
  const exists = options.exists ?? existsSync;
  const isFile = options.isFile ?? ((path) => statSync(path).isFile());
  const isDirectory =
    options.isDirectory ?? ((path) => statSync(path).isDirectory());
  const listFiles = options.listFiles ?? ((dir) => readdirSync(dir));
  const defaultCommand =
    options.defaultCommand ??
    (options.libraryHooksDir === undefined
      ? () => undefined
      : castleHookDefaultResolver(
          options.libraryHooksDir,
          options.projectHooksDir,
          options.projectRoot,
          exists,
          listFiles,
          isFile,
        ));
  const inline = collectInlineHookCommands(config);

  const resolved = {} as ResolvedCastleHooks;
  for (const name of CASTLE_HOOK_NAMES) {
    const commands: string[] = [];
    const defaults =
      CASTLE_HOOK_DEFAULTS_REGISTRY[
        name as keyof typeof CASTLE_HOOK_DEFAULTS_REGISTRY
      ];

    if (defaults) {
      for (const defaultName of defaults) {
        if (config[`afk.hooks.defaults.${defaultName}`] === "false") continue;
        const command = defaultCommand(defaultName);
        if (command !== undefined) commands.push(command);
      }
    }

    const flatBody = flatPointBody(
      name,
      options.libraryHooksDir,
      options.projectHooksDir,
      exists,
      isFile,
    );
    if (flatBody !== undefined) commands.push(flatBody);
    commands.push(
      ...listPointDirScripts(
        name,
        options.libraryHooksDir,
        options.projectHooksDir,
        listFiles,
        exists,
        isDirectory,
      ),
    );
    commands.push(...(inline.get(name) ?? []));
    resolved[name] = commands;
  }
  return resolved;
}

function parseJsonObject(text: string): CastleHookContext | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

export async function dispatchCastleHook(
  name: CastleHookName,
  commands: readonly string[],
  context: CastleHookContext,
  exec: CastleHookExec,
  options: DispatchCastleHookOptions = {},
): Promise<CastleHookDispatchResult> {
  if (!isCastleHookName(name)) throw new UnknownCastleHookError(name);

  const log = options.log ?? (() => {});
  const executions: CastleHookExecution[] = [];
  const policy = CASTLE_HOOK_EXIT_POLICY[name];
  let current = context;

  for (const command of commands) {
    if (command.length === 0) continue;

    log(`[castle:hooks] ${name}: enter: ${command}`);
    const env = deriveCastleHookEnv(options.env ?? {}, current);
    const { code, stdout } = await exec(command, env, JSON.stringify(current));
    executions.push({ name, command, rc: code });
    log(`[castle:hooks] ${name}: exit rc=${code}: ${command}`);

    if (code !== 0) {
      if (policy === "abort") {
        log(`[castle:hooks] ${name}: command failed (rc=${code}): ${command}`);
        return {
          context: current,
          aborted: true,
          vetoed: name === "pre_requeue",
          rc: code,
          executions,
        };
      }
      log(
        `[castle:hooks] ${name}: command failed (rc=${code}), continuing: ${command}`,
      );
      continue;
    }

    const trimmed = stdout.trim();
    if (trimmed.length === 0) continue;

    const next = parseJsonObject(trimmed);
    if (next !== undefined) {
      current = next;
      continue;
    }

    if (policy === "abort") {
      log(
        `[castle:hooks] ${name}: non-JSON stdout (parse failure) from: ${command}`,
      );
      return {
        context: current,
        aborted: true,
        vetoed: name === "pre_requeue",
        rc: PARSE_FAILURE_RC,
        executions,
      };
    }
    log(
      `[castle:hooks] ${name}: non-JSON stdout, ignoring (parse failure): ${command}`,
    );
  }

  return { context: current, aborted: false, vetoed: false, rc: 0, executions };
}
