import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";
import {
  composeRepair,
  noRepair,
  type RepairAction,
  type RepairArgument,
} from "@reddb-io/shared/repair.js";

export type DangerPosture = "allow" | "confirm" | "deny";

export interface DangerRefusal {
  refused: true;
  posture: DangerPosture;
  action: string;
  reason: string;
  repair: RepairAction | "none";
  repair_reason?: string;
}

function refusal(
  posture: DangerPosture,
  toolName: string,
  input: Record<string, unknown> = {},
): DangerRefusal {
  const composed = posture === "confirm"
    ? composeRepair({
        state: "dangerous tool requires explicit confirmation",
        repair: {
          tool: toolName,
          args: {
            ...(input as Record<string, RepairArgument>),
            confirmation: true,
          },
          why: "retry the same operation with explicit confirmation",
        },
      })
    : composeRepair({
        state: "dangerous tool is denied by the configured posture",
        repair: noRepair("the configured posture deliberately forbids this tool"),
      });
  return {
    refused: true,
    posture,
    action: toolName,
    reason: composed.prose,
    repair: composed.repair,
    ...(composed.repair === "none"
      ? { repair_reason: composed.repair_reason }
      : {}),
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
          return refusal("confirm", tool.name, input);
        }
        const { confirmation: _c, ...rest } = input;
        return realInvoke(rest);
      },
    };
  });
}
