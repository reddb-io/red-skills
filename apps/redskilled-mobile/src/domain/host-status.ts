/**
 * host-status — the link's verdict about the Host, derived from evidence.
 *
 * The card used to say "online" the moment a Host was PAIRED, which is a fact
 * about the past (a pairing succeeded once) presented as a fact about now. The
 * only honest input is the last state read that actually answered: fresh means
 * online, aging means stale, silent means unreachable — and before the first
 * answer the app says it is still connecting rather than guessing either way.
 */
export type HostLinkStatus = "connecting" | "online" | "stale" | "unreachable";

/** A state read younger than this proves the Host is answering now. */
export const HOST_ONLINE_WINDOW_MS = 10_000;
/** Beyond this, silence stops being jitter and becomes an outage. */
export const HOST_STALE_WINDOW_MS = 30_000;

/** Derive the verdict from the last answered read. PURE. */
export function deriveHostStatus(
  lastAnsweredAtMs: number | null,
  nowMs: number,
): HostLinkStatus {
  if (lastAnsweredAtMs == null) return "connecting";
  const age = nowMs - lastAnsweredAtMs;
  if (age < HOST_ONLINE_WINDOW_MS) return "online";
  if (age < HOST_STALE_WINDOW_MS) return "stale";
  return "unreachable";
}
