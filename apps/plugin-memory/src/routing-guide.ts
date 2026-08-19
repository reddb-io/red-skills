export type MemoryRoutingAgent =
  | "codex"
  | "claude"
  | "cursor"
  | "gemini"
  | "aider"
  | "opencode"
  | "generic";

export type MemoryIntegrationTransport = "agent-rules" | "mcp" | "hooks" | "http";

export interface MemoryRoutingRule {
  when: string;
  call: string;
  reason: string;
}

export type MemoryMapRelationFilter =
  | "call"
  | "import"
  | "type"
  | "validation"
  | "decision"
  | "work"
  | "reference";

export interface MemoryMapContextExample {
  question: string;
  relationFilters: MemoryMapRelationFilter[];
  call: string;
  followUp: string;
}

export interface MemoryRoutingGuide {
  schemaVersion: "memory.routing_guide.v1";
  agent: MemoryRoutingAgent;
  supportedAgents: MemoryRoutingAgent[];
  integration: MemoryAgentIntegration;
  targetFiles: string[];
  mcpTools: string[];
  cliFallbacks: string[];
  rules: MemoryRoutingRule[];
  mapContext: {
    kind: "agent_context";
    description: string;
    relationFilters: MemoryMapRelationFilter[];
    examples: MemoryMapContextExample[];
  };
  safetyNotes: string[];
  installSnippet: string;
}

export interface MemoryConfigSnippet {
  label: string;
  path: string;
  body: string;
}

export interface MemoryAgentIntegration {
  displayName: string;
  transports: MemoryIntegrationTransport[];
  targetFiles: string[];
  configSnippets: MemoryConfigSnippet[];
  connectCommands: string[];
  notes: string[];
}

export interface MemoryRoutingGuideOptions {
  agent?: MemoryRoutingAgent;
}

export const SUPPORTED_ROUTING_AGENTS: MemoryRoutingAgent[] = [
  "codex",
  "claude",
  "cursor",
  "gemini",
  "aider",
  "opencode",
  "generic",
];

const RULES: MemoryRoutingRule[] = [
  {
    when: "Before broad grep, recursive file reads, or opening many source files to understand code structure",
    call: "memory_map_context with the concrete code question; use context filters such as call, import, type, validation, decision, work, or reference when known",
    reason: "Route through the RedDB graph first so the agent gets a compact cited NODE/EDGE slice with weights, salience, confidence, and sources before spending tokens on raw code.",
  },
  {
    when: "Before architecture, migration, or multi-file implementation work",
    call: "memory_context_pack with the concrete goal",
    reason: "Load prior decisions, validations, warnings, and citations before planning.",
  },
  {
    when: "Before claiming a design or rule is current",
    call: "memory_claim_check with the exact assertion",
    reason: "Check active, superseded, and contradictory evidence instead of trusting memory.",
  },
  {
    when: "When the task asks what changed, what can break, or what a PR needs",
    call: "memory_pre_pr_review with explicit changed_files",
    reason: "Connect changed files to concepts, decisions, known failures, and validations.",
  },
  {
    when: "When touching an unfamiliar file or symbol",
    call: "memory_structural_impact with file/symbol; use memory_path_explain when two labels need a relationship explanation",
    reason: "Find graph-backed imports, call/type/schema relationships, and cited paths between concepts.",
  },
  {
    when: "When the user asks about project history, prior discussion, docs, or decisions",
    call: "memory_recall first; use memory_doc_search and memory_doc_read for ingested document chunks",
    reason: "Prefer zero-token retrieval and local source reads before asking an LLM to synthesize.",
  },
  {
    when: "When starting in an unfamiliar repo or after a long gap",
    call: "memory_handoff, then memory_onboarding_map and memory_readiness for the immediate goal",
    reason: "Get where-we-left-off context, map-first orientation, and a readiness score with missing-evidence warnings.",
  },
  {
    when: "When preserving a durable operational decision, fix, gotcha, or agent-work preference",
    call: "memory_store only for operational evidence; route Personal facts and human-facing context to Brain",
    reason: "Keep Memory useful without turning it into a Personal fact store.",
  },
];

const MAP_RELATION_FILTERS: MemoryMapRelationFilter[] = [
  "call",
  "import",
  "type",
  "validation",
  "decision",
  "work",
  "reference",
];

const MAP_CONTEXT_EXAMPLES: MemoryMapContextExample[] = [
  {
    question: "Which auth files should I inspect before changing token refresh?",
    relationFilters: ["import", "call", "type", "validation"],
    call: "memory_map_context with relation filters import, call, type, validation; use memory_structural_impact when a specific file or symbol is already known",
    followUp: "Open the smallest set of cited files/tests from the map before falling back to grep.",
  },
  {
    question: "Why does this API handler depend on the session schema?",
    relationFilters: ["call", "type", "reference", "decision"],
    call: "memory_map_context with relation filters call, type, reference, decision; use memory_path_explain when both endpoint labels are known",
    followUp: "Use the returned path as context for source reads; verify the current code after reading the mapped files.",
  },
  {
    question: "What work and validation evidence touches this migration?",
    relationFilters: ["work", "validation", "decision", "reference"],
    call: "memory_map_context with relation filters work, validation, decision, reference; use memory_pre_pr_review when changed_files are known",
    followUp: "Treat the result as triage context for the next reads, not as a final generated answer.",
  },
];

const MCP_TOOLS = [
  "memory_map_context",
  "memory_recall",
  "memory_context_pack",
  "memory_handoff",
  "memory_readiness",
  "memory_claim_check",
  "memory_doc_search",
  "memory_doc_read",
  "memory_pre_pr_review",
  "memory_path_explain",
  "memory_structural_impact",
  "memory_onboarding_map",
  "memory_store",
];

const CLI_FALLBACKS = [
  "memory map-context <query> --json",
  "memory recall <query>",
  "memory context-pack <goal> --json",
  "memory handoff [focus] --json",
  "memory readiness <goal> --json",
  "memory claim-check <assertion> --json",
  "memory docs search <query> --json",
  "memory docs read <path|rid> --json",
  "memory docs restore [path|rid] --dry-run --json",
  "memory pre-pr-review --json",
  "memory path-explain <from> <to> --json",
  "memory structural-impact --file <path>",
  "memory onboarding-map --json",
  "memory store <fact>",
];

export function buildMemoryRoutingGuide(
  opts: MemoryRoutingGuideOptions = {},
): MemoryRoutingGuide {
  const agent = opts.agent ?? "generic";
  const integration = integrationForAgent(agent);
  const targetFiles = integration.targetFiles;
  const safetyNotes = [
    "Read-only tools are preferred before mutating Memory.",
    "Map context is agent context for routing source reads; verify the current worktree before making code claims.",
    "memory_store is durable; do not store secrets, raw credentials, Personal facts, human-facing context, or transient chain-of-thought.",
    "Personal facts, biographical details, identity context, and durable human preferences belong in Brain, not Memory.",
    "memory_supersede and conflict-resolution tools are mutating; use them only with explicit user intent.",
    "Citations such as memory_nodes:<rid> should be kept in summaries when they support an important claim.",
  ];
  return {
    schemaVersion: "memory.routing_guide.v1",
    agent,
    supportedAgents: SUPPORTED_ROUTING_AGENTS,
    integration,
    targetFiles,
    mcpTools: MCP_TOOLS,
    cliFallbacks: CLI_FALLBACKS,
    rules: RULES,
    mapContext: {
      kind: "agent_context",
      description:
        "RedDB-backed code-structure context used to choose the next source reads before broad grep or recursive file opens. It is not a generated answer and does not replace checking the current worktree.",
      relationFilters: MAP_RELATION_FILTERS,
      examples: MAP_CONTEXT_EXAMPLES,
    },
    safetyNotes,
    installSnippet: renderMemoryRoutingSnippet({ agent, targetFiles, safetyNotes }),
  };
}

function integrationForAgent(agent: MemoryRoutingAgent): MemoryAgentIntegration {
  const sharedMcp = mcpSnippet();
  const sharedHttp = httpSnippet();
  if (agent === "claude") {
    return {
      displayName: "Claude Code",
      transports: ["agent-rules", "mcp", "hooks", "http"],
      targetFiles: ["CLAUDE.md"],
      configSnippets: [sharedMcp, sharedHttp, hookSnippet("claude")],
      connectCommands: [
        "memory init --mode graph --hooks --skill-telemetry --yes",
        "memory routing-guide --agent claude",
        "memory-mcp",
      ],
      notes: ["Claude can use both the Memory MCP server and bundled Claude hook manifest."],
    };
  }
  if (agent === "codex") {
    return {
      displayName: "Codex CLI",
      transports: ["agent-rules", "mcp", "hooks", "http"],
      targetFiles: ["AGENTS.md"],
      configSnippets: [sharedMcp, sharedHttp, hookSnippet("codex")],
      connectCommands: [
        "memory init --mode graph --hooks --skill-telemetry --yes",
        "memory routing-guide --agent codex",
        "memory-mcp",
      ],
      notes: [
        "Codex can use AGENTS.md routing, the Memory MCP server, and bundled Codex hook manifest when plugin hooks are enabled.",
      ],
    };
  }
  if (agent === "cursor") {
    return {
      displayName: "Cursor",
      transports: ["agent-rules", "mcp", "http"],
      targetFiles: [".cursor/rules/memory.md"],
      configSnippets: [sharedMcp, sharedHttp],
      connectCommands: ["memory routing-guide --agent cursor", "memory-mcp", "memory serve"],
      notes: ["Cursor support is MCP/HTTP-first; lifecycle capture still comes from explicit Memory CLI calls or another hook-capable runner."],
    };
  }
  if (agent === "gemini") {
    return {
      displayName: "Gemini CLI",
      transports: ["agent-rules", "mcp", "http"],
      targetFiles: ["GEMINI.md"],
      configSnippets: [sharedMcp, sharedHttp],
      connectCommands: ["memory routing-guide --agent gemini", "memory-mcp", "memory serve"],
      notes: ["Gemini support is MCP/HTTP-first and uses the same RedDB-backed project store."],
    };
  }
  if (agent === "aider") {
    return {
      displayName: "Aider",
      transports: ["agent-rules", "mcp", "http"],
      targetFiles: ["CONVENTIONS.md"],
      configSnippets: [sharedMcp, sharedHttp],
      connectCommands: ["memory routing-guide --agent aider", "memory-mcp", "memory serve"],
      notes: ["Aider support is rule-file plus MCP/HTTP guidance; Memory remains the local RedDB persistence layer."],
    };
  }
  if (agent === "opencode") {
    return {
      displayName: "OpenCode",
      transports: ["agent-rules", "mcp", "http"],
      targetFiles: ["AGENTS.md"],
      configSnippets: [sharedMcp, sharedHttp],
      connectCommands: ["memory routing-guide --agent opencode", "memory-mcp", "memory serve"],
      notes: ["OpenCode support is MCP/HTTP-first until a runner-specific hook manifest is added."],
    };
  }
  return {
    displayName: "Generic MCP or HTTP agent",
    transports: ["agent-rules", "mcp", "http"],
    targetFiles: ["AGENTS.md", "CLAUDE.md"],
    configSnippets: [sharedMcp, sharedHttp],
    connectCommands: ["memory routing-guide --agent generic", "memory-mcp", "memory serve"],
    notes: ["Any agent that can call MCP tools or loopback HTTP can share the same project-local RedDB Memory store."],
  };
}

function mcpSnippet(): MemoryConfigSnippet {
  return {
    label: "MCP stdio server",
    path: "agent MCP server configuration",
    body: JSON.stringify(
      {
        mcpServers: {
          "reddb-memory": {
            command: "memory-mcp",
            env: {
              MEMORY_ROOT: "${workspaceFolder}",
            },
          },
        },
      },
      null,
      2,
    ),
  };
}

function httpSnippet(): MemoryConfigSnippet {
  return {
    label: "Loopback HTTP API",
    path: "shell",
    body: "memory serve --host 127.0.0.1 --port 3113 --token-env MEMORY_HTTP_TOKEN",
  };
}

function hookSnippet(runner: "claude" | "codex"): MemoryConfigSnippet {
  return {
    label: `${runner} lifecycle hooks`,
    path: `plugins/memory/hooks/${runner}.hooks.json`,
    body: `memory hook <SessionStart|PostToolUse|Stop|PreCompact> --runner ${runner}`,
  };
}

function renderMemoryRoutingSnippet(input: {
  agent: MemoryRoutingAgent;
  targetFiles: string[];
  safetyNotes: string[];
}): string {
  const integration = integrationForAgent(input.agent);
  const lines = [
    "## Memory Routing",
    "",
    "Use the Memory MCP tools proactively when prior project knowledge could change the answer.",
    "",
    "Integration:",
    `- Agent: ${integration.displayName}`,
    `- Transports: ${integration.transports.join(", ")}`,
    "- MCP server command: `memory-mcp`",
    "- Optional HTTP workbench/API: `memory serve --host 127.0.0.1 --port 3113`",
    "",
    "Map context before broad source reads:",
    "- For code-structure questions, call `memory_map_context` before broad grep, recursive file reads, or opening many source files; use `memory_structural_impact`, `memory_path_explain`, or `memory_pre_pr_review` when you already have a concrete file, symbol, path endpoint, or change set.",
    "- Treat the returned map as agent context for choosing the next files, symbols, tests, and decisions to inspect; it is not a generated answer.",
    `- Relation filters to apply while reading map context: ${MAP_RELATION_FILTERS.join(", ")}.`,
    ...MAP_CONTEXT_EXAMPLES.map(
      (example) =>
        `- ${example.question}: ${example.call}; filters=${example.relationFilters.join(", ")}; ${example.followUp}`,
    ),
    "",
    "Rules:",
    ...RULES.map((rule) => `- ${rule.when}: call \`${rule.call}\` - ${rule.reason}`),
    "",
    "Safety:",
    ...input.safetyNotes.map((note) => `- ${note}`),
    "",
    `Target file${input.targetFiles.length === 1 ? "" : "s"}: ${input.targetFiles.join(", ")}`,
  ];
  if (input.agent !== "generic") lines.push(`Agent: ${input.agent}`);
  return `${lines.join("\n")}\n`;
}
