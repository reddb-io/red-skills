// Single source of truth for the apps/rsp vitest suite split (#1873).
//
// The default AFK feedback gate must stay inside its subprocess budget. Specs
// that spawn CLIs, drive resident daemons, build large RedDB stores, or assert
// wall-clock/benchmark behavior run as an explicit integration suite instead.

export const INTEGRATION_TESTS: readonly string[] = [
  "cli.test.ts",
  "command-boundary.test.ts",
  "cli-resident.test.ts",
  "cli-telemetry.test.ts",
  "cli-wait-show.test.ts",
  "elision-store.test.ts",
  "intercept.test.ts",
  "proxy.test.ts",
  "resident-cutover.test.ts",
  "resident-memory.test.ts",
  "setup.test.ts",
  "shell-init.test.ts",
  "surface-parity.test.ts",
  "telemetry.test.ts",
  "two-axis-benchmark.test.ts",
];

export const integrationGlobs = (): string[] =>
  INTEGRATION_TESTS.map((name) => `tests/${name}`);
