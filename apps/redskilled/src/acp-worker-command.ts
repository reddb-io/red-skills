/** Internal CLI adapter for a daemon-selected Workflow Worker child endpoint. */
import { parseFlags } from "@reddb-io/shared/args.js";
import { ACP_AGENT_IDS, type AcpAgentId } from "./acp-agent-catalog.js";
import { runNativeAcpWorker } from "./acp-native-worker.js";

const ACP_WORKER_FLAGS = {
  socket: { kind: "value", coerce: (raw: string) => raw },
  "child-agent": { kind: "value", coerce: requireAcpAgentId },
  "child-command": { kind: "value", coerce: (raw: string) => raw },
  "child-arg": { kind: "value", type: "array", coerce: (raw: string) => raw },
} as const;

export async function runAcpWorkerCommand(args: readonly string[]): Promise<number> {
  const { values } = parseFlags(args, ACP_WORKER_FLAGS);
  if (values.socket == null || values.socket === "") throw new Error("acp-worker requires --socket");
  if (values["child-agent"] == null || values["child-command"] == null) {
    throw new Error("acp-worker requires a daemon-selected child ACP Agent endpoint");
  }
  return await runNativeAcpWorker(values.socket, {
    agent: values["child-agent"],
    transport: "stdio",
    command: values["child-command"],
    args: values["child-arg"] ?? [],
  });
}

function requireAcpAgentId(raw: string): AcpAgentId {
  if ((ACP_AGENT_IDS as readonly string[]).includes(raw)) return raw as AcpAgentId;
  throw new Error(`unsupported child ACP Agent: ${raw}`);
}
