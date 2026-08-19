// `rs_brain` — the brain plugin's thin Plugin MCP (ADR 0147 rule 2, ADR 0152).
export {
  createRsBrainTools,
  rsBrainToolCoverage,
  RS_BRAIN_CALL_METHOD,
  RS_BRAIN_MCP_SERVER_NAME,
  type RsBrainTool,
} from "./tool.js";
export {
  createRsBrainMcpServer,
  rsBrainCallArguments,
  type CreateRsBrainMcpServerOptions,
  type RsBrainInvoke,
} from "./server.js";
