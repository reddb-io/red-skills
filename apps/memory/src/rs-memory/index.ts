// `rs_memory` — the memory plugin's thin Plugin MCP (ADR 0147 rule 2, ADR 0152).
export {
  createRsMemoryCoreTools,
  RS_MEMORY_CALL_METHOD,
  RS_MEMORY_CORE_TOOL_NAMES,
  RS_MEMORY_MCP_SERVER_NAME,
  RS_MEMORY_SURFACE_TOOL,
  type RsMemoryTool,
} from "./tool.js";
export {
  createRsMemoryMcpServer,
  renderMemoryAnswer,
  type CreateRsMemoryMcpServerOptions,
  type RsMemoryInvoke,
} from "./server.js";
