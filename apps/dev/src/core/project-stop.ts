export type ProjectStopStatus = "unreachable" | "already-stopped" | "stopped";

/** Classify only what the Project authority observed, never the requested intent. */
export function projectStopStatus(input: {
  readonly deregistered: boolean;
  readonly unreachable: boolean;
}): ProjectStopStatus {
  if (input.unreachable) return "unreachable";
  return input.deregistered ? "stopped" : "already-stopped";
}
