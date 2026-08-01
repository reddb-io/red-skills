/**
 * log-follow — which lines of a re-read tail are new.
 *
 * A log panel refreshes by re-reading the tail, so the same lines arrive again
 * every tick and only the difference should be printed. Appending the whole tail
 * each time is the bug this module exists to prevent; so is assuming the file
 * only ever grows, because a Worker that rotates or truncates its log would
 * otherwise leave the panel replaying a history that is no longer there.
 *
 * PURE: the state is a value, so a test can drive a whole session of refreshes
 * without a file or an editor.
 */

export interface FollowState {
  /** Which Worker this panel is following; a change is a full reset. */
  readonly workerId: string | null;
  /** The lines already printed, kept only to recognise them coming back. */
  readonly printed: readonly string[];
}

export interface FollowStep {
  readonly state: FollowState;
  /** Print these, in order. */
  readonly append: readonly string[];
  /** True when the panel must be emptied before appending. */
  readonly reset: boolean;
}

export const EMPTY_FOLLOW: FollowState = { workerId: null, printed: [] };

/**
 * The next step for a panel following `workerId`, given a freshly read tail.
 *
 * The overlap is found by matching the longest suffix of what was printed
 * against a prefix of the new tail. That is what makes a rotated or truncated log
 * a RESET rather than a duplicate: when nothing printed still lines up with the
 * new bytes, the honest answer is to clear the panel and print what is there now.
 */
export function followTail(
  state: FollowState,
  workerId: string,
  lines: readonly string[],
): FollowStep {
  if (state.workerId !== workerId) {
    return { state: { workerId, printed: [...lines] }, append: [...lines], reset: true };
  }
  if (state.printed.length === 0) {
    return { state: { workerId, printed: [...lines] }, append: [...lines], reset: false };
  }

  const overlap = longestOverlap(state.printed, lines);
  if (overlap === 0 && lines.length > 0) {
    // Nothing printed lines up with the file's current tail: it rotated, was
    // truncated, or scrolled entirely out of the window. Replaying on top of the
    // old text would narrate a history that no longer exists.
    return { state: { workerId, printed: [...lines] }, append: [...lines], reset: true };
  }

  const append = lines.slice(overlap);
  return {
    state: { workerId, printed: [...state.printed, ...append] },
    append,
    reset: false,
  };
}

/**
 * The length of the longest suffix of `printed` that is also a prefix of `lines`.
 *
 * Zero means the two share no boundary at all. Bounded by the shorter of the two,
 * so a long-lived panel does not pay for its whole history on every refresh.
 */
export function longestOverlap(printed: readonly string[], lines: readonly string[]): number {
  const max = Math.min(printed.length, lines.length);
  for (let length = max; length > 0; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (printed[printed.length - length + index] !== lines[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}
