import { spawn } from "node:child_process";

export type LiveBaselineCompetitor = "agentmemory";
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

export function agentmemoryBaselineCommandFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = env.MEMORY_AGENTMEMORY_BASELINE_CMD;
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

export function createAgentmemoryCliBaselineAdapter(
  opts: AgentmemoryCliBaselineAdapterOptions = {},
): LiveBaselineAdapter {
  const command = opts.command ?? [];
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const executor = opts.executor;

  return {
    id: "agentmemory-cli",
    competitor: "agentmemory",
    capabilities() {
      return [{ ...AGENTMEMORY_CAPABILITY }];
    },
    async run(runOpts) {
      if (!runOpts.enabled) {
        return {
          competitor: "agentmemory",
          adapter: "agentmemory-cli",
          state: "skipped",
          source: "live-cli",
          configured: false,
          capabilityId: AGENTMEMORY_CAPABILITY.id,
          command: [...command],
          metrics: {},
          evidence: [],
          summary: "Agentmemory live baseline not requested.",
        };
      }

      if (!executor) {
        return {
          competitor: "agentmemory",
          adapter: "agentmemory-cli",
          state: "unavailable",
          source: "live-cli",
          configured: true,
          capabilityId: AGENTMEMORY_CAPABILITY.id,
          command: [...command],
          metrics: {},
          evidence: [],
          summary: "Agentmemory live baseline has no CLI executor configured.",
        };
      }

      if (command.length === 0) {
        return {
          competitor: "agentmemory",
          adapter: "agentmemory-cli",
          state: "unavailable",
          source: "live-cli",
          configured: false,
          capabilityId: AGENTMEMORY_CAPABILITY.id,
          command: [],
          metrics: {},
          evidence: [],
          summary: "Agentmemory live baseline needs MEMORY_AGENTMEMORY_BASELINE_CMD.",
          error: "missing MEMORY_AGENTMEMORY_BASELINE_CMD",
        };
      }

      const result = await executor(command, { timeoutMs });
      if (isUnavailable(result)) {
        return {
          competitor: "agentmemory",
          adapter: "agentmemory-cli",
          state: "unavailable",
          source: "live-cli",
          configured: false,
          capabilityId: AGENTMEMORY_CAPABILITY.id,
          command: [...command],
          metrics: {},
          evidence: [],
          summary: "Agentmemory CLI command is not available in this environment.",
          error: result.stderr || result.error?.message,
        };
      }
      const normalized = result.status === 0 ? normalizeAgentmemoryOutput(result.stdout) : undefined;
      return {
        competitor: "agentmemory",
        adapter: "agentmemory-cli",
        state: result.status === 0 && normalized ? "measured" : "failed",
        source: "live-cli",
        configured: true,
        capabilityId: AGENTMEMORY_CAPABILITY.id,
        command: [...command],
        metrics: normalized?.metrics ?? {},
        evidence: normalized?.evidence ?? [],
        summary: normalized?.summary ?? "Agentmemory live baseline failed.",
        error: normalized ? undefined : result.stderr || result.error?.message || "invalid Agentmemory baseline JSON",
      };
    },
  };
}

function isUnavailable(result: CliExecutionResult): boolean {
  const code = "code" in (result.error ?? {}) ? (result.error as NodeJS.ErrnoException).code : undefined;
  return result.status === 127 || code === "ENOENT";
}

function normalizeAgentmemoryOutput(stdout: string):
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
    : "Agentmemory live baseline completed.";
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
