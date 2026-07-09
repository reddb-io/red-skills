// The AFK worker identity's host half (issue #1327).
//
// The claim substrate (ADR 0066) identifies a worker as `<host>:<worker_id>` and
// that identity is emitted verbatim into PUBLIC issue comments and `afk:claim`
// markers. Emitting the raw `hostname()` leaks the operator's machine name into
// a public repo, so the host half is replaced by a fingerprint: the md5 of the
// host name truncated to twelve hex chars.
//
// Obfuscation, NOT a security boundary — md5 and the truncation are chosen for
// brevity and readability, not for preimage resistance. Requirements are only:
// deterministic per host (so a worker still recognizes its own marker and the
// same-host death-cause gate keeps working) and distinct across hosts in
// practice (so two machines never collide on one claim identity).
//
// Every site that builds the host half routes through here. Legacy markers left
// on live issues still carry a raw hostname; they parse unchanged and simply
// read as a different (cross-host) claimant — degrade gracefully, no migration.

import { createHash } from "node:crypto";
import { hostname } from "node:os";

/** Hex chars kept from the md5 digest. Twelve reads like a short device id and
 * gives ~48 bits — far past collision range for a fleet of machines. */
export const HOST_FINGERPRINT_LENGTH = 12;

/** Fingerprint an arbitrary host name (pure — the testable core). */
export function fingerprintHost(host: string): string {
  return createHash("md5").update(host).digest("hex").slice(0, HOST_FINGERPRINT_LENGTH);
}

/** This host's fingerprint — the host half of every emitted worker identity. */
export function hostFingerprint(): string {
  return fingerprintHost(hostname());
}

/** `<fingerprint>:` — the prefix a same-host claim identity starts with. */
export function hostFingerprintPrefix(): string {
  return `${hostFingerprint()}:`;
}

/** The full claim identity for a worker on this host: `<fingerprint>:<worker_id>`. */
export function workerIdentity(workerId: string): string {
  return `${hostFingerprintPrefix()}${workerId}`;
}
