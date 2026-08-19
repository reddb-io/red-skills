import { afterEach, describe, test } from "vitest";
import {
  cleanupMcpServerTest,
  runRegistryBackedReadinessAndTrustTools,
  TIMEOUT,
} from "./mcp-server-test-helpers.js";

afterEach(cleanupMcpServerTest);

describe("MCP server over stdio", () => {
  test(
    "registry-backed readiness and trust tools return representative read-only outputs",
    runRegistryBackedReadinessAndTrustTools,
    TIMEOUT,
  );
});
