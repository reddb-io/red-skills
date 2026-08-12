/** The transactional boundary between a live incumbent and its successor. */
import type { RedskilledEventLane } from "../event-lane.js";
import type { RedskilledPaths } from "../paths.js";
import {
  completeRedskilledReplacement,
  prepareRedskilledReplacement,
  stageRedskilledReplacementSuccessor,
  type RedskilledReplacementDecision,
  type RedskilledReplacementIO,
} from "../self-replace.js";

export interface ReplaceWithViableSuccessorInput {
  readonly decision: Extract<RedskilledReplacementDecision, { act: "replace" }>;
  readonly io: RedskilledReplacementIO;
  readonly paths: RedskilledPaths;
  readonly idleMs?: number;
  readonly incumbentVersion: string;
  readonly incumbentPid: number;
  readonly clock: () => string;
  readonly eventLane: RedskilledEventLane;
  readonly flushRegistration: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly onViable: () => void;
}

/** Prove succession before stopping the incumbent; false leaves it live. */
export async function replaceWithViableSuccessor(
  input: ReplaceWithViableSuccessorInput,
): Promise<boolean> {
  const prepared = prepareRedskilledReplacement(input.decision, input.io, input.paths, input.idleMs);
  const options = {
    ...(input.idleMs == null ? {} : { idleMs: input.idleMs }),
    io: input.io,
  };
  let successor;
  try {
    successor = await stageRedskilledReplacementSuccessor(prepared, input.paths, options);
  } catch {
    await input.eventLane.recordDaemonTakeoverFailed({
      ts: input.clock(),
      pid: input.incumbentPid,
      socketPath: input.paths.socketPath,
      detail:
        `redskilled ${input.decision.to} failed its takeover boot handshake; ` +
        `incumbent ${input.incumbentVersion} remains live`,
    });
    return false;
  }
  input.onViable();
  await input.eventLane.flush().catch(() => undefined);
  await input.flushRegistration().catch(() => undefined);
  try {
    await input.stop();
  } catch (error) {
    successor?.abort();
    throw error;
  }
  completeRedskilledReplacement(prepared, input.paths, {
    ...options,
    ...(successor == null ? {} : { successor }),
  });
  return true;
}
