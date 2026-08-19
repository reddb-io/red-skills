// `rs_github` — the cross-plugin GitHub MCP (ADR 0147 rule 2).
export {
  createRsGithubTools,
  RS_GITHUB_MCP_SERVER_NAME,
  RS_GITHUB_REQUEST_METHOD,
  RS_GITHUB_REQUEST_TOOL,
  type RsGithubTool,
} from "./tool.js";
export {
  createRsGithubMcpServer,
  rsGithubRequestParams,
  type CreateRsGithubMcpServerOptions,
  type RsGithubInvoke,
} from "./server.js";
