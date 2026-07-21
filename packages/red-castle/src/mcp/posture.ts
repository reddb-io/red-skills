import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export type DangerPosture = "allow" | "confirm" | "deny";

export interface DangerRefusal {
  refused: true;
  posture: DangerPosture;
  action: string;
  reason: string;
}

function refusal(posture: DangerPosture, toolName: string): DangerRefusal {
  return {
    refused: true,
    posture,
    action: toolName,
    reason:
      posture === "confirm"
        ? "dangerous tool requires explicit confirmation — retry with confirmation: true"
        : "dangerous tool is denied by the configured posture",
  };
}

/**
 * Wrap all tools that carry a `dangerClass` with the caller-supplied posture:
 *
 * - `allow`  (default) — no wrapping, behavior unchanged.
 * - `confirm` — adds `confirmation?: boolean` to each dangerous tool's input
 *   schema; invocations without `confirmation: true` receive a structured
 *   refusal instead of executing.
 * - `deny`   — every invocation of a dangerous tool returns a structured
 *   refusal regardless of inputs.
 */
export function applyDangerPosture(
  tools: CastleMcpTool[],
  posture: DangerPosture,
): CastleMcpTool[] {
  if (posture === "allow") return tools;

  return tools.map((tool) => {
    if (!tool.dangerClass) return tool;

    if (posture === "deny") {
      return {
        ...tool,
        invoke: async (_input) => refusal("deny", tool.name),
      };
    }

    // posture === "confirm"
    const augmentedSchema: Record<string, z.ZodType> = {
      ...tool.inputSchema,
      confirmation: z.boolean().optional(),
    };
    const realInvoke = tool.invoke.bind(tool);
    return {
      ...tool,
      inputSchema: augmentedSchema,
      invoke: async (input) => {
        if (input["confirmation"] !== true) {
          return refusal("confirm", tool.name);
        }
        const { confirmation: _c, ...rest } = input;
        return realInvoke(rest);
      },
    };
  });
}
