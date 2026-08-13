/**
 * Hard ceiling for process fixtures that deliberately outlive their parent.
 * This module ships only in the test tree: production processes have no
 * synthetic lifetime and no configuration surface for one.
 */
export const TEST_PROCESS_MAX_LIFETIME_MS = 180_000;

interface TestProcessLifetimeOptions {
  schedule?: (callback: () => void, delayMs: number) => { unref(): unknown };
  exit?: (code: number) => unknown;
}

/** Arm the fixed test-fixture ceiling without keeping an otherwise-finished process alive. */
export function armTestProcessLifetime(
  options: TestProcessLifetimeOptions = {},
): void {
  const schedule = options.schedule ?? setTimeout;
  const exit = options.exit ?? process.exit;
  const timer = schedule(() => exit(124), TEST_PROCESS_MAX_LIFETIME_MS);
  timer.unref();
}
