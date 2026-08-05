/** The release schemes standardized by ADR 0139. */
export type VersionScheme = "semver" | "calver";

/** Counts of queued changesets by impact class. */
export interface PendingBumpSummary {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Calendar input supplied at the release boundary; the core never reads wall time. */
export interface ReleaseClock {
  today(): { readonly year: number; readonly month: number };
}

export interface NextVersionInput {
  readonly currentVersion: string;
  readonly pending: PendingBumpSummary;
  readonly scheme: VersionScheme;
  readonly clock: ReleaseClock;
  readonly prerelease?: "rc";
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly rc?: number;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;

/**
 * Compute the next version from explicit inputs only.
 *
 * Semver applies the highest queued impact. Calver treats that impact as
 * metadata and advances `YYYY.M.MICRO` using the injected calendar. An RC is
 * derived from that same target; a subsequent call advances only `rc.N`.
 */
export function computeNextVersion(input: NextVersionInput): string {
  assertPending(input.pending);
  const current = parseVersion(input.currentVersion);

  if (current.rc !== undefined) {
    const base = renderBase(current);
    return input.prerelease === "rc" ? `${base}-rc.${current.rc + 1}` : base;
  }

  const target = input.scheme === "semver"
    ? nextSemver(current, input.pending)
    : nextCalver(current, input.clock.today());
  const base = renderBase(target);
  return input.prerelease === "rc" ? `${base}-rc.1` : base;
}

function assertPending(pending: PendingBumpSummary): void {
  const counts = [pending.major, pending.minor, pending.patch];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("pending bump counts must be non-negative safe integers");
  }
  if (counts.every((count) => count === 0)) {
    throw new Error("cannot compute a release version without a pending bump");
  }
}

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`invalid semver-compatible release version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { rc: Number(match[4]) }),
  };
}

function nextSemver(current: ParsedVersion, pending: PendingBumpSummary): ParsedVersion {
  if (pending.major > 0) return { major: current.major + 1, minor: 0, patch: 0 };
  if (pending.minor > 0) return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

function nextCalver(
  current: ParsedVersion,
  date: { readonly year: number; readonly month: number },
): ParsedVersion {
  if (!Number.isSafeInteger(date.year) || date.year < 1) {
    throw new Error(`invalid release year: ${date.year}`);
  }
  if (!Number.isSafeInteger(date.month) || date.month < 1 || date.month > 12) {
    throw new Error(`invalid release month: ${date.month}`);
  }

  if (current.major > date.year || (current.major === date.year && current.minor > date.month)) {
    throw new Error(
      `release clock ${date.year}.${date.month} precedes current calver ${renderBase(current)}`,
    );
  }
  return current.major === date.year && current.minor === date.month
    ? { major: date.year, minor: date.month, patch: current.patch + 1 }
    : { major: date.year, minor: date.month, patch: 0 };
}

function renderBase(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

