import { spawn } from "node:child_process";

export type LiveBaselineCompetitor = "agentmemory" | "agent-memory";
export type LiveBaselineTransport = "cli";
export type LiveBaselineState = "skipped" | "unavailable" | "measured" | "failed";

export interface LiveBaselineCapability {
  id: string;
  competitor: LiveBaselineCompetitor;
  transport: LiveBaselineTransport;
  description: string;
}

export interface LiveBaselineRunResult {
  competitor: LiveBaselineCompetitor;
  adapter: string;
  state: LiveBaselineState;
  source: "live-cli";
  configured: boolean;
  capabilityId: string;
  command: string[];
  metrics: Record<string, number>;
  evidence: string[];
  summary: string;
  error?: string;
}

export interface LiveBaselineRunOptions {
  enabled: boolean;
  now?: number;
}

export interface LiveBaselineAdapter {
  id: string;
  competitor: LiveBaselineCompetitor;
  capabilities(): LiveBaselineCapability[];
  run(opts: LiveBaselineRunOptions): Promise<LiveBaselineRunResult>;
}

export interface CliExecutionResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException | Error;
}

export type CliExecutor = (command: string[], opts: { timeoutMs: number }) => Promise<CliExecutionResult>;

export interface AgentmemoryCliBaselineAdapterOptions {
  command?: string[];
  executor?: CliExecutor;
  timeoutMs?: number;
}

export interface Neo4jAgentMemoryCliBaselineAdapterOptions {
  command?: string[];
  executor?: CliExecutor;
  timeoutMs?: number;
}

export function agentmemoryBaselineCommandFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  return baselineCommandFromEnv("MEMORY_AGENTMEMORY_BASELINE_CMD", env);
}

export function neo4jAgentMemoryBaselineCommandFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  return baselineCommandFromEnv("MEMORY_NEO4J_AGENT_MEMORY_BASELINE_CMD", env);
}

function baselineCommandFromEnv(name: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, ""));
  }
  return undefined;
}

export const defaultCliExecutor: CliExecutor = (command, opts) => {
  return new Promise((resolve) => {
    if (command.length === 0) {
      resolve({ status: null, stdout: "", stderr: "", error: new Error("empty command") });
      return;
    }
    const child = spawn(command[0]!, command.slice(1), {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    const finish = (result: CliExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      finish({
        status,
        stdout,
        stderr,
        error: timedOut ? new Error(`command timed out after ${opts.timeoutMs}ms`) : undefined,
      });
    });
  });
};

const AGENTMEMORY_CAPABILITY: LiveBaselineCapability = {
  id: "agentmemory.cli.recall",
  competitor: "agentmemory",
  transport: "cli",
  description: "Run a live rohitg00/agentmemory recall baseline through a JSON-emitting CLI command.",
};

const NEO4J_AGENT_MEMORY_CAPABILITY: LiveBaselineCapability = {
  id: "recall latency",
  competitor: "agent-memory",
  transport: "cli",
  description: "Run a live neo4j-labs/agent-memory recall-latency baseline through a JSON-emitting CLI command.",
};

export function createAgentmemoryCliBaselineAdapter(
  opts: AgentmemoryCliBaselineAdapterOptions = {},
): LiveBaselineAdapter {
  return createJsonCliBaselineAdapter({
    id: "agentmemory-cli",
    competitor: "agentmemory",
    capability: AGENTMEMORY_CAPABILITY,
    command: opts.command,
    executor: opts.executor,
    timeoutMs: opts.timeoutMs,
    missingCommandEnv: "MEMORY_AGENTMEMORY_BASELINE_CMD",
    skippedSummary: "Agentmemory live baseline not requested.",
    noExecutorSummary: "Agentmemory live baseline has no CLI executor configured.",
    missingCommandSummary: "Agentmemory live baseline needs MEMORY_AGENTMEMORY_BASELINE_CMD.",
    unavailableSummary: "Agentmemory CLI command is not available in this environment.",
    failedSummary: "Agentmemory live baseline failed.",
    defaultSummary: "Agentmemory live baseline completed.",
  });
}

export function createNeo4jAgentMemoryCliBaselineAdapter(
  opts: Neo4jAgentMemoryCliBaselineAdapterOptions = {},
): LiveBaselineAdapter {
  return createJsonCliBaselineAdapter({
    id: "neo4j-agent-memory-cli",
    competitor: "agent-memory",
    capability: NEO4J_AGENT_MEMORY_CAPABILITY,
    command: opts.command,
    executor: opts.executor,
    timeoutMs: opts.timeoutMs,
    missingCommandEnv: "MEMORY_NEO4J_AGENT_MEMORY_BASELINE_CMD",
    skippedSummary: "Neo4j Agent Memory live baseline not requested.",
    noExecutorSummary: "Neo4j Agent Memory live baseline has no CLI executor configured.",
    missingCommandSummary:
      "Neo4j Agent Memory live baseline needs MEMORY_NEO4J_AGENT_MEMORY_BASELINE_CMD.",
    unavailableSummary: "Neo4j Agent Memory CLI command is not available in this environment.",
    failedSummary: "Neo4j Agent Memory live baseline failed.",
    defaultSummary: "Neo4j Agent Memory live baseline completed.",
  });
}

function createJsonCliBaselineAdapter(input: {
  id: string;
  competitor: LiveBaselineCompetitor;
  capability: LiveBaselineCapability;
  command?: string[];
  executor?: CliExecutor;
  timeoutMs?: number;
  missingCommandEnv: string;
  skippedSummary: string;
  noExecutorSummary: string;
  missingCommandSummary: string;
  unavailableSummary: string;
  failedSummary: string;
  defaultSummary: string;
}): LiveBaselineAdapter {
  const command = input.command ?? [];
  const timeoutMs = input.timeoutMs ?? 30_000;
  const executor = input.executor;

  return {
    id: input.id,
    competitor: input.competitor,
    capabilities() {
      return [{ ...input.capability }];
    },
    async run(runOpts) {
      if (!runOpts.enabled) {
        return {
          competitor: input.competitor,
          adapter: input.id,
          state: "skipped",
          source: "live-cli",
          configured: false,
          capabilityId: input.capability.id,
          command: [...command],
          metrics: {},
          evidence: [],
          summary: input.skippedSummary,
        };
      }

      if (!executor) {
        return {
          competitor: input.competitor,
          adapter: input.id,
          state: "unavailable",
          source: "live-cli",
          configured: true,
          capabilityId: input.capability.id,
          command: [...command],
          metrics: {},
          evidence: [],
          summary: input.noExecutorSummary,
        };
      }

      if (command.length === 0) {
        return {
          competitor: input.competitor,
          adapter: input.id,
          state: "unavailable",
          source: "live-cli",
          configured: false,
          capabilityId: input.capability.id,
          command: [],
          metrics: {},
          evidence: [],
          summary: input.missingCommandSummary,
          error: `missing ${input.missingCommandEnv}`,
        };
      }

      const result = await executor(command, { timeoutMs });
      if (isUnavailable(result)) {
        return {
          competitor: input.competitor,
          adapter: input.id,
          state: "unavailable",
          source: "live-cli",
          configured: false,
          capabilityId: input.capability.id,
          command: [...command],
          metrics: {},
          evidence: [],
          summary: input.unavailableSummary,
          error: result.stderr || result.error?.message,
        };
      }
      const normalized = result.status === 0 ? normalizeBaselineOutput(result.stdout, input.defaultSummary) : undefined;
      return {
        competitor: input.competitor,
        adapter: input.id,
        state: result.status === 0 && normalized ? "measured" : "failed",
        source: "live-cli",
        configured: true,
        capabilityId: input.capability.id,
        command: [...command],
        metrics: normalized?.metrics ?? {},
        evidence: normalized?.evidence ?? [],
        summary: normalized?.summary ?? input.failedSummary,
        error: normalized ? undefined : result.stderr || result.error?.message || "invalid baseline JSON",
      };
    },
  };
}

function isUnavailable(result: CliExecutionResult): boolean {
  const code = "code" in (result.error ?? {}) ? (result.error as NodeJS.ErrnoException).code : undefined;
  return result.status === 127 || code === "ENOENT";
}

function normalizeBaselineOutput(
  stdout: string,
  defaultSummary: string,
):
  | {
      metrics: Record<string, number>;
      evidence: string[];
      summary: string;
    }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const metrics = numericRecord(obj.metrics);
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence.filter((item): item is string => typeof item === "string")
    : [];
  const summary = typeof obj.summary === "string" && obj.summary.trim().length > 0
    ? obj.summary
    : defaultSummary;
  return { metrics, evidence, summary };
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
  }
  return out;
}
