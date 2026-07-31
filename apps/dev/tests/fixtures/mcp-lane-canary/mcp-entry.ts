// Harness stand-in for the shipped `castle-mcp.bundle.min.mjs`.
//
// It bundles to a file with the SHIPPED NAME, so the production entry resolver
// (`resolveDevScriptPath`) engages exactly as it does under a real MCP host,
// and it drives the REAL `main` router plus the REAL `createCastleMcpServer`
// tool surface. Only the resident lanes (curator, merge driver) are stubbed —
// they reach GitHub and are not what #2677 broke.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCastleMcpServer, main } from "../../../src/mcp-server.js";

process.exitCode = await main(process.argv.slice(2), {
  startCurator: async () => undefined,
  startMergeDriver: async () => undefined,
  connect: async () => {
    await createCastleMcpServer(process.cwd()).connect(new StdioServerTransport());
  },
});
