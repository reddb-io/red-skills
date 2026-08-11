import type { z } from "zod/v3";
import type { CastleMcpOutputContract } from "./contracts.js";

/**
 * One published redskilled MCP tool. A description starting with `MUTATING:` is
 * the declared mutation mode — the client docs contract reads that prefix.
 *
 * `dangerClass` marks tools that the posture gate intercepts.  Domain modules
 * set it on declaration; the aggregator wires the gate centrally.
 *
 * `outputContract` declares the tool's versioned output shape. Domain modules
 * set it on declaration; the aggregator wires the validation centrally. A tool
 * without one publishes an undeclared payload — valid, just uncontracted.
 */
export interface CastleMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  dangerClass?: string;
  outputContract?: CastleMcpOutputContract;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}
