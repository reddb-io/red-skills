import type { ChannelBridge } from "@reddb-io/brain-store/channel-bridge.js";
import { EventArtifactMapper } from "./event-artifact-mapper.js";
import type { BrainStoreLike } from "@reddb-io/brain-store/store.js";

export interface IngestEventsInput {
  bridge: ChannelBridge;
  store: BrainStoreLike;
  afterCursor?: number | string;
  sessionKey?: string;
  limit?: number;
  sourceAgent?: string;
}

export interface IngestEventsResult {
  polled: number;
  captured: number;
  skipped: number;
  nextCursor?: number | string;
}

export async function ingestEvents(input: IngestEventsInput): Promise<IngestEventsResult> {
  const mapper = new EventArtifactMapper();

  const pollResult = await input.bridge.poll({
    afterCursor: input.afterCursor,
    sessionKey: input.sessionKey,
    limit: input.limit,
  });

  const existingRids = new Set(
    (await input.store.listArtifacts()).map((a) => a.rid),
  );

  let captured = 0;
  let skipped = 0;

  for (const event of pollResult.events) {
    const captureInput = mapper.map({ event, sourceAgent: input.sourceAgent });
    const artifact = await input.store.capture(captureInput);
    if (existingRids.has(artifact.rid)) {
      skipped++;
    } else {
      captured++;
      existingRids.add(artifact.rid);
    }
  }

  return {
    polled: pollResult.events.length,
    captured,
    skipped,
    nextCursor: pollResult.nextCursor,
  };
}
