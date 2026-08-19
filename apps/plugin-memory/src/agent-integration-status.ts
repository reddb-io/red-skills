import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readConfig } from "./config.js";
import { buildHookCoverageReport, type HookCoverageReport } from "./hook-coverage.js";
import {
  buildMemoryRoutingGuide,
  SUPPORTED_ROUTING_AGENTS,
  type MemoryRoutingAgent,
} from "./routing-guide.js";

export type MemoryAgentIntegrationState = "ready" | "partial" | "missing";

export interface MemoryAgentRuleFileStatus {
  path: string;
  exists: boolean;
  contains_memory_routing: boolean;
}

export interface MemoryAgentIntegrationItem {
  agent: MemoryRoutingAgent;
  display_name: string;
  state: MemoryAgentIntegrationState;
  transports: string[];
  target_files: MemoryAgentRuleFileStatus[];
  mcp_tools: number;
  cli_fallbacks: number;
  hook_coverage: {
    supported: boolean;
    effective_events: number;
    total_events: number;
    actionable_gaps: number;
  } | null;
  recommended_next_actions: string[];
}

export interface MemoryAgentIntegrationStatus {
  schema_version: "memory.agent_integration_status.v1";
  read_only: true;
  root: string;
  generated_at: string;
  mode: string;
  summary: {
    agents: number;
    ready: number;
    partial: number;
    missing: number;
  };
  agents: MemoryAgentIntegrationItem[];
  sources: {
    routing_guide: "memory.routing_guide.v1";
    hook_coverage: HookCoverageReport["schema_version"];
  };
  recommended_next_actions: string[];
}

export async function buildMemoryAgentIntegrationStatus(
  rootDir: string,
  opts: { agent?: MemoryRoutingAgent; now?: number } = {},
): Promise<MemoryAgentIntegrationStatus> {
  const root = resolve(rootDir);
  const [config, hookCoverage] = await Promise.all([
    readConfig(root),
    buildHookCoverageReport(root),
  ]);
  const agents = opts.agent ? [opts.agent] : SUPPORTED_ROUTING_AGENTS;
  const items = await Promise.all(
    agents.map((agent) => agentStatus(root, agent, hookCoverage)),
  );
  const summary = {
    agents: items.length,
    ready: items.filter((item) => item.state === "ready").length,
    partial: items.filter((item) => item.state === "partial").length,
    missing: items.filter((item) => item.state === "missing").length,
  };
  return {
    schema_version: "memory.agent_integration_status.v1",
    read_only: true,
    root,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    mode: config?.mode ?? "uninitialized",
    summary,
    agents: items,
    sources: {
      routing_guide: "memory.routing_guide.v1",
      hook_coverage: hookCoverage.schema_version,
    },
    recommended_next_actions: nextActions(items),
  };
}

async function agentStatus(
  root: string,
  agent: MemoryRoutingAgent,
  hookCoverage: HookCoverageReport,
): Promise<MemoryAgentIntegrationItem> {
  const guide = buildMemoryRoutingGuide({ agent });
  const targetFiles = await Promise.all(
    guide.targetFiles.map((target) => ruleFileStatus(root, target)),
  );
  const runnerCoverage =
    agent === "codex" || agent === "claude"
      ? hookCoverage.runners.find((runner) => runner.runner === agent)
      : undefined;
  const hookStatus = guide.integration.transports.includes("hooks")
    ? {
        supported: true,
        effective_events: runnerCoverage?.coverage.effective ?? 0,
        total_events: runnerCoverage?.coverage.total ?? 0,
        actionable_gaps: runnerCoverage?.actionable_gaps.length ?? 0,
      }
    : null;
  const hasRoutedFile = targetFiles.some((file) => file.contains_memory_routing);
  const hasAnyFile = targetFiles.some((file) => file.exists);
  const hooksReady =
    hookStatus == null ||
    (hookStatus.effective_events > 0 && hookStatus.actionable_gaps === 0);
  const state: MemoryAgentIntegrationState =
    hasRoutedFile && hooksReady
      ? "ready"
      : hasAnyFile || hasRoutedFile || (hookStatus?.effective_events ?? 0) > 0
        ? "partial"
        : "missing";
  return {
    agent,
    display_name: guide.integration.displayName,
    state,
    transports: guide.integration.transports,
    target_files: targetFiles,
    mcp_tools: guide.mcpTools.length,
    cli_fallbacks: guide.cliFallbacks.length,
    hook_coverage: hookStatus,
    recommended_next_actions: itemActions(agent, targetFiles, hookStatus),
  };
}

async function ruleFileStatus(root: string, target: string): Promise<MemoryAgentRuleFileStatus> {
  const path = join(root, target);
  const exists = await fileExists(path);
  const body = exists ? await readFile(path, "utf8").catch(() => "") : "";
  return {
    path: target,
    exists,
    contains_memory_routing:
      body.includes("## Memory Routing") ||
      body.includes("memory-mcp") ||
      body.includes("memory_context_pack"),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function itemActions(
  agent: MemoryRoutingAgent,
  files: MemoryAgentRuleFileStatus[],
  hookStatus: MemoryAgentIntegrationItem["hook_coverage"],
): string[] {
  const actions: string[] = [];
  if (!files.some((file) => file.contains_memory_routing)) {
    actions.push(`review \`memory routing-guide --agent ${agent}\` and add the snippet to ${files.map((file) => file.path).join(" or ")}`);
  }
  if (hookStatus && hookStatus.effective_events === 0) {
    actions.push("enable Memory graph hooks with `memory init --mode graph --hooks --yes`");
  }
  if (actions.length === 0) actions.push("agent integration is ready");
  return actions;
}

function nextActions(items: MemoryAgentIntegrationItem[]): string[] {
  const actions = items
    .filter((item) => item.state !== "ready")
    .flatMap((item) => item.recommended_next_actions);
  if (actions.length === 0) actions.push("all selected agent integrations are ready");
  return [...new Set(actions)].slice(0, 12);
}
