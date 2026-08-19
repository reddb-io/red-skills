/**
 * optional-mcp — the MCP servers a plugin declares only when the project asks
 * for them (ADR 0147 §4, issue #4010).
 *
 * `red-ui` shipped inside the memory and brain `.mcp.json`, which meant every
 * session in every project running either plugin fetched a third-party package
 * over `npx` and started a viewer nobody had opened. A default is the wrong
 * shape for a surface most projects never look at, and switching it off after
 * the fact is a per-machine edit to a file the marketplace overwrites.
 *
 * So the shipped declaration carries what the plugin OWNS, and this module
 * carries what the project may add: one catalog, keyed by the same
 * `plugins.<name>.enabled` gate every other RedSkills opt-in uses (ADR 0067),
 * composed onto the declaration by whoever is projecting it for a host.
 */

/** One MCP server as a host reads it out of `.mcp.json`. */
export interface McpServerDeclaration {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** An optional server: its name, the config key that admits it, its transport. */
export interface OptionalMcpServer {
  readonly name: string;
  /** Flattened `.red/config.yaml` key; strict `"true"` admits, nothing else. */
  readonly configKey: string;
  readonly server: McpServerDeclaration;
}

/**
 * The memory/brain graph viewer. Fetched on demand rather than pinned, because
 * it is a consumer of the local store rather than a component of it.
 */
const RED_UI: McpServerDeclaration = {
  command: "npx",
  args: ["-y", "@reddb-io/ui@latest", "mcp", "--stdio"],
  env: { RED_UI_APP_URL: "https://ui.reddb.io" },
};

const RED_UI_ENTRY: OptionalMcpServer = {
  name: "red-ui",
  configKey: "plugins.red-ui.enabled",
  server: RED_UI,
};

/**
 * Optional servers per plugin. Both memory and brain offer the same viewer over
 * the same one gate, so opting in once lights it wherever it applies — a reader
 * who wrote `plugins.red-ui.enabled: true` asked for the viewer, not for one
 * plugin's copy of it.
 */
export const OPTIONAL_MCP_SERVERS: Readonly<Record<string, readonly OptionalMcpServer[]>> = {
  memory: [RED_UI_ENTRY],
  brain: [RED_UI_ENTRY],
};

/** Flattened `.red/config.yaml` values, as the config parsers hand them over. */
export type OptionalMcpConfigValues = Readonly<Record<string, string | undefined>>;

/** The optional servers one plugin's config admits, in catalog order. */
export function optedInMcpServers(
  plugin: string,
  values: OptionalMcpConfigValues,
): Record<string, McpServerDeclaration> {
  const admitted: Record<string, McpServerDeclaration> = {};
  for (const entry of OPTIONAL_MCP_SERVERS[plugin] ?? []) {
    if (values[entry.configKey] === "true") admitted[entry.name] = entry.server;
  }
  return admitted;
}

/**
 * One plugin's full MCP declaration: what it ships, plus what the project opted
 * into. The shipped entries win a name collision — a plugin that starts owning
 * a server outright stops being asked about it.
 */
export function pluginMcpDeclaration<T>(
  plugin: string,
  declared: Readonly<Record<string, T>>,
  values: OptionalMcpConfigValues,
): Record<string, T | McpServerDeclaration> {
  return { ...optedInMcpServers(plugin, values), ...declared };
}
