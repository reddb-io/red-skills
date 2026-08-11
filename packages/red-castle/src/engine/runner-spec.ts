import type { AgentEffort, AgentRunner, Runner } from "./runner-types.js";
import { MINIMAX_M3_MODEL, resolveMiniMaxClaudeEnv } from "./minimax-env.js";
import { openCodeAuthEnv, resolveOpenCodeAuth } from "./opencode-env.js";

export type ImplementerRunner = "claude" | "codex" | "opencode" | "pi";
export type ImplementerConfigValues = Readonly<Record<string, string>>;

export interface ImplementerEnabledSurfaces {
  plugins: Array<"dev" | "memory" | "brain">;
  mcp: Array<"navigator" | "red-memory" | "brain" | "red-ui" | "rsp">;
  rsp: boolean;
}

export type ImplementerSpawnConstraint =
  | {
      kind: "claude-settings";
      flags: readonly ["--bare", "--strict-mcp-config"];
      settings: {
        plugins: ImplementerEnabledSurfaces["plugins"];
        mcpServers: ImplementerEnabledSurfaces["mcp"];
        hooks: readonly [];
        rsp: boolean;
      };
    }
  | {
      kind: "codex-config";
      config: {
        plugins: Record<
          "dev@red-skills" | "memory@red-skills" | "brain@red-skills",
          boolean
        >;
        mcpServers: Record<
          "navigator" | "redskilled" | "red-memory" | "brain" | "red-ui" | "rsp",
          boolean
        >;
        hooks: false;
        rsp: boolean;
      };
    }
  | {
      kind: "opencode-config";
      config: {
        plugins: ImplementerEnabledSurfaces["plugins"];
        mcp: Record<
          "navigator" | "redskilled" | "red-memory" | "brain" | "red-ui" | "rsp",
          { enabled: boolean }
        >;
        pluginEvents: readonly [];
        rsp: boolean;
      };
    }
  | {
      kind: "pi-flags";
      flags: readonly [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
      ];
      skills: ImplementerEnabledSurfaces["plugins"];
      extensions: ImplementerEnabledSurfaces["mcp"];
      rsp: boolean;
    };

export interface ImplementerEnvironmentProjection {
  runner: ImplementerRunner;
  enabled: ImplementerEnabledSurfaces;
  constraint: ImplementerSpawnConstraint;
}

type ImplementerProjector = (
  enabled: ImplementerEnabledSurfaces,
) => ImplementerSpawnConstraint;

export const CODEX_EFFORTS: readonly AgentEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];
export const CLAUDE_EFFORTS: readonly AgentEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const MINIMAX_EFFORTS: readonly AgentEffort[] = ["low"];

export interface RunnerSpec {
  efforts: readonly AgentEffort[];
  channel: "effort" | "variant";
  factory: "claudeCode" | "codex" | "opencode";
  forcedModel?: string;
  defaultEffort?: AgentEffort;
  resolveAuthEnv?: (
    env: NodeJS.ProcessEnv,
  ) => Record<string, string> | undefined;
  structuredOutput?: boolean;
  /**
   * Model-slug families this runner's CLI can dispatch. A runner with a
   * `forcedModel` accepts that slug only; a runner with no families listed
   * accepts any slug. Consulted by callers that must resolve runner+model as a
   * coherent PAIR before spawning — pinning a codex slug on the claude CLI is
   * not a degraded run, it is an immediate non-zero exit.
   */
  modelFamilies?: readonly RegExp[];
  /** Native CLI constraint for an inner agent's config-gated environment. */
  projectImplementerEnvironment: ImplementerProjector;
}

const claudeImplementerEnvironment: ImplementerProjector = (enabled) => ({
  kind: "claude-settings",
  flags: ["--bare", "--strict-mcp-config"],
  settings: {
    plugins: [...enabled.plugins],
    mcpServers: [...enabled.mcp],
    hooks: [],
    rsp: enabled.rsp,
  },
});

const codexImplementerEnvironment: ImplementerProjector = (enabled) => ({
  kind: "codex-config",
  config: {
    plugins: {
      "dev@red-skills": true,
      "memory@red-skills": enabled.plugins.includes("memory"),
      "brain@red-skills": enabled.plugins.includes("brain"),
    },
    mcpServers: {
      navigator: true,
      redskilled: false,
      "red-memory": enabled.mcp.includes("red-memory"),
      brain: enabled.mcp.includes("brain"),
      "red-ui": enabled.mcp.includes("red-ui"),
      rsp: enabled.mcp.includes("rsp"),
    },
    hooks: false,
    rsp: enabled.rsp,
  },
});

const openCodeImplementerEnvironment: ImplementerProjector = (enabled) => ({
  kind: "opencode-config",
  config: {
    plugins: [...enabled.plugins],
    mcp: {
      navigator: { enabled: true },
      redskilled: { enabled: false },
      "red-memory": { enabled: enabled.mcp.includes("red-memory") },
      brain: { enabled: enabled.mcp.includes("brain") },
      "red-ui": { enabled: enabled.mcp.includes("red-ui") },
      rsp: { enabled: enabled.mcp.includes("rsp") },
    },
    pluginEvents: [],
    rsp: enabled.rsp,
  },
});

const piImplementerEnvironment: ImplementerProjector = (enabled) => ({
  kind: "pi-flags",
  flags: [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
  ],
  skills: [...enabled.plugins],
  extensions: [...enabled.mcp],
  rsp: enabled.rsp,
});

export const RUNNER_SPECS: Record<AgentRunner, RunnerSpec> = {
  claude: {
    efforts: CLAUDE_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    structuredOutput: true,
    // Full ids (`claude-opus-4-8`, `us.anthropic.claude-…`) plus the CLI's own
    // short aliases.
    modelFamilies: [/claude/i, /^(opus|sonnet|haiku|opusplan|default)$/i],
    projectImplementerEnvironment: claudeImplementerEnvironment,
  },
  codex: {
    efforts: CODEX_EFFORTS,
    channel: "effort",
    factory: "codex",
    modelFamilies: [/^gpt-/i, /^o\d/i, /^codex/i],
    projectImplementerEnvironment: codexImplementerEnvironment,
  },
  opencode: {
    efforts: CLAUDE_EFFORTS,
    channel: "variant",
    factory: "opencode",
    resolveAuthEnv: (env) => openCodeAuthEnv(resolveOpenCodeAuth(env)),
    // `<provider>/<model>` — the leading segment routes the endpoint (ADR 0059).
    modelFamilies: [/^[^/\s]+\/.+$/],
    projectImplementerEnvironment: openCodeImplementerEnvironment,
  },
  "claude-minimax": {
    efforts: MINIMAX_EFFORTS,
    channel: "effort",
    factory: "claudeCode",
    forcedModel: MINIMAX_M3_MODEL,
    defaultEffort: "low",
    resolveAuthEnv: resolveMiniMaxClaudeEnv,
    projectImplementerEnvironment: claudeImplementerEnvironment,
  },
};

function enabledImplementerSurfaces(
  values: ImplementerConfigValues,
): ImplementerEnabledSurfaces {
  const memory = values["plugins.memory.enabled"] === "true";
  const brain = values["plugins.brain.enabled"] === "true";
  const redUi = values["plugins.red-ui.enabled"] === "true";
  const rsp = values["rsp.enabled"] === "true";
  return {
    plugins: [
      "dev",
      ...(memory ? ["memory" as const] : []),
      ...(brain ? ["brain" as const] : []),
    ],
    mcp: [
      "navigator",
      ...(memory ? ["red-memory" as const] : []),
      ...(brain ? ["brain" as const] : []),
      ...(redUi ? ["red-ui" as const] : []),
      ...(rsp ? ["rsp" as const] : []),
    ],
    rsp,
  };
}

/**
 * Project the repo's existing activation gates onto one runner's native
 * discovery constraint. Dev + navigator are the fixed implementer essentials;
 * every optional surface is strict `enabled: true`, with no payload allowlist.
 */
export function projectImplementerEnvironment(
  runner: ImplementerRunner,
  values: ImplementerConfigValues,
): ImplementerEnvironmentProjection {
  const enabled = enabledImplementerSurfaces(values);
  const projector =
    runner === "pi"
      ? piImplementerEnvironment
      : RUNNER_SPECS[runner].projectImplementerEnvironment;
  return { runner, enabled, constraint: projector(enabled) };
}

export function toAgentRunner(r: Runner): AgentRunner {
  return r === "codex" || r === "opencode" || r === "claude-minimax"
    ? r
    : "claude";
}

export function runnerSupportsStructuredOutput(runner: AgentRunner): boolean {
  return RUNNER_SPECS[runner].structuredOutput === true;
}

/**
 * Can `runner`'s CLI actually dispatch `model`? A blank slug is never runnable;
 * a `forcedModel` runner accepts only that slug; a runner without declared
 * families accepts anything. This is the registry seam for resolving a
 * runner/model PAIR, so an operator's cross-runner model pin is substituted
 * before spawn instead of exiting non-zero at run time.
 */
export function runnerSupportsModel(
  runner: AgentRunner,
  model: string,
): boolean {
  const spec = RUNNER_SPECS[runner];
  const slug = model.trim();
  if (slug.length === 0) return false;
  if (spec.forcedModel) return slug === spec.forcedModel;
  if (!spec.modelFamilies || spec.modelFamilies.length === 0) return true;
  return spec.modelFamilies.some((family) => family.test(slug));
}
