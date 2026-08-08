/** Position-aware reads for one atomically rotated append lane. */
import { open } from "node:fs/promises";

/** Opaque file-generation identity and byte boundary held by a tailing consumer. */
export interface EventLanePosition {
  /** File identity plus creation instant, preventing inode-reuse ABA after several rotations. */
  readonly generation: string;
  readonly offset: number;
}

export interface PositionedEventRead<TEvent> {
  readonly status: "current" | "rebaseline-required";
  readonly exists: boolean;
  /** Everything after a current position, or the whole visible generation after rotation. */
  readonly events: readonly TEvent[];
  readonly position: EventLanePosition | null;
}

/**
 * Read from one observed generation without confusing a reused offset for history.
 *
 * A stale reader still receives every event the current bounded lane can show.
 * The status is separate because those events are not a replacement for the
 * missing prefix; stateful consumers must re-baseline before following again.
 */
export async function readPositionedEventLane<TEvent>(
  path: string,
  position: EventLanePosition | null | undefined,
  decode: (raw: string) => TEvent[],
): Promise<PositionedEventRead<TEvent>> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: position == null ? "current" : "rebaseline-required",
        exists: false,
        events: [],
        position: null,
      };
    }
    throw error;
  }

  try {
    const metadata = await handle.stat({ bigint: true });
    const raw = await handle.readFile();
    const nextPosition: EventLanePosition = {
      generation: `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`,
      offset: raw.byteLength,
    };
    const rotated = position != null &&
      (position.generation !== nextPosition.generation || position.offset > raw.byteLength);
    const all = decode(raw.toString("utf8"));
    if (position == null || rotated) {
      return {
        status: rotated ? "rebaseline-required" : "current",
        exists: true,
        events: all,
        position: nextPosition,
      };
    }

    // Positions are handed out only at complete append boundaries. Parsing the
    // prefix through the lane decoder keeps headers out of the count and avoids
    // inventing a second record parser for cursor reads.
    const seen = decode(raw.subarray(0, position.offset).toString("utf8")).length;
    return {
      status: "current",
      exists: true,
      events: all.slice(seen),
      position: nextPosition,
    };
  } finally {
    await handle.close();
  }
}
