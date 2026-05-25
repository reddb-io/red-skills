import { readConfig } from "./config.js";
import { resolveProvider, type Egress, type ProviderMode } from "./extract-conversation.js";
import type { MemoryStore } from "./graph-store.js";

export interface MemoryExtractionStatus {
  schema_version: "memory.extraction_status.v1";
  read_only: true;
  root: string;
  generated_at: string;
  deterministic: {
    markdown_entities: true;
    code_calls: true;
    code_type_uses: true;
    sql_schema_references: true;
    dev_workflow: true;
    structured_transcript: true;
  };
  inferred: {
    configured: boolean;
    available: boolean;
    mode: ProviderMode | null;
    model: string | null;
    endpoint: string | null;
    egress: Egress | null;
    hook_stop_enabled: boolean;
    facts: number;
    error?: string;
  };
  recommended_next_actions: string[];
}

export async function buildMemoryExtractionStatus(
  store: MemoryStore,
  rootDir: string,
  opts: { now?: number } = {},
): Promise<MemoryExtractionStatus> {
  const [config, nodes] = await Promise.all([readConfig(rootDir), store.listNodes()]);
  const facts = nodes.filter((node) => node.properties.confidence === "INFERRED").length;
  const inferred = {
    configured: false,
    available: false,
    mode: null as ProviderMode | null,
    model: null as string | null,
    endpoint: null as string | null,
    egress: null as Egress | null,
    hook_stop_enabled: config?.hooks.stop === true,
    facts,
    error: undefined as string | undefined,
  };

  if (!config) {
    inferred.error = "memory is not initialized";
  } else if (config.mode !== "graph") {
    inferred.error = `memory is ${config.mode}; inferred extraction requires graph mode`;
  } else if (!config.provider) {
    inferred.error = "no AI provider configured for inferred extraction";
  } else {
    inferred.configured = true;
    try {
      const resolved = resolveProvider(config.provider);
      inferred.available = true;
      inferred.mode = resolved.mode;
      inferred.model = resolved.model;
      inferred.endpoint = resolved.endpoint;
      inferred.egress = resolved.egress;
    } catch (err) {
      inferred.error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    schema_version: "memory.extraction_status.v1",
    read_only: true,
    root: rootDir,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    deterministic: {
      markdown_entities: true,
      code_calls: true,
      code_type_uses: true,
      sql_schema_references: true,
      dev_workflow: true,
      structured_transcript: true,
    },
    inferred,
    recommended_next_actions: extractionActions(inferred),
  };
}

function extractionActions(status: MemoryExtractionStatus["inferred"]): string[] {
  const actions: string[] = [];
  if (!status.configured) {
    actions.push("use `memory extract --local` for structured transcripts or configure `provider` for free-form inferred extraction");
  }
  if (status.configured && !status.available) {
    actions.push("fix the configured Memory AI provider before running `memory extract`");
  }
  if (status.available && !status.hook_stop_enabled) {
    actions.push("enable the Stop hook if you want session-end inferred extraction");
  }
  if (status.available && status.facts === 0) {
    actions.push("run `memory extract <transcript>` to seed inferred facts");
  }
  if (actions.length === 0) actions.push("Memory extraction paths are ready");
  return actions;
}
