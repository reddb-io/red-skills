// stale-base-drift — the observed base-movement fact consumed by Verdict.
// Attribution, accounting, and parking deliberately do not live here: Verdict
// owns those decisions once checks, history, and this fact are present.

/** What the base ref did while one Worker round was running. */
export interface BaseMovement {
  /** Base head sha resolved when the Worker's branch was prepared. */
  readonly startSha: string;
  /** Base head sha observed when the machine gate failed. */
  readonly gateSha: string;
  /** Subjects of commits gained in between, oldest to newest. */
  readonly subjects: readonly string[];
  /** Repository-relative paths changed by the gained base commits. */
  readonly files?: readonly string[];
}

/** Missing or incomplete evidence never invents movement. */
export function baseMoved(movement: BaseMovement | undefined): boolean {
  if (!movement?.startSha || !movement.gateSha) return false;
  return movement.startSha !== movement.gateSha;
}
