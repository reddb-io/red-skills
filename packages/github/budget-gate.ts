// budget-gate.ts — the balance may WATCH every call; by default it stops none.
//
// **The quota belongs to the operator.** The reserved band was written so a
// spent pool refused a convenience read before it refused a claim, and the
// ordering is still right — but it was on by default, which made the client the
// authority on how an operator may spend their own token. An operator who wants
// to burn the whole quota is not making a mistake the library gets to prevent.
//
// **Off by default is also the hang's cure.** A gate that refuses on a balance
// must first HAVE a balance, so every read waited on a balance ask, and a stalled
// ask wedged reads that had nothing to do with it (#3768). With the gate off
// nothing on the read path waits for the balance at all: the ask stays a
// background observation and the read goes straight to GitHub.
//
// **Telemetry is not gating and does not move.** The balance-history lane, the
// spend ledger and the rate-limit reporting all keep running in both modes. What
// this switch controls is exactly one thing: whether an observation is allowed to
// turn into a refusal.

/** Whether the balance may refuse a call, or only describe one. */
export type GithubBudgetGateMode = "off" | "on";

/** Off: a client that was told nothing never refuses on budget. */
export const DEFAULT_GITHUB_BUDGET_GATE: GithubBudgetGateMode = "off";

/** The config key that turns the gate on, in `.red/config.yaml`. */
export const GITHUB_BUDGET_GATE_CONFIG_KEY = "github.budget_gate";

/** The env override, for a single run that wants the other mode. */
export const GITHUB_BUDGET_GATE_ENV = "RED_GITHUB_BUDGET_GATE";

/**
 * Read a declared mode out of whatever a config or env produced. PURE.
 *
 * Anything unrecognised is `off`, not an error: this is read on the path that
 * decides whether GitHub gets asked at all, and a typo in a config key must not
 * be the thing that starts refusing an operator's own reads.
 */
export function githubBudgetGate(value: unknown): GithubBudgetGateMode {
  if (value === true) return "on";
  if (typeof value !== "string") return DEFAULT_GITHUB_BUDGET_GATE;
  const normalized = value.trim().toLowerCase();
  return normalized === "on" || normalized === "enabled" || normalized === "true"
    ? "on"
    : DEFAULT_GITHUB_BUDGET_GATE;
}

/** True when the balance is allowed to refuse. PURE. */
export function githubBudgetGateEnabled(mode: GithubBudgetGateMode | undefined): boolean {
  return (mode ?? DEFAULT_GITHUB_BUDGET_GATE) === "on";
}

/**
 * The mode this process runs under when nothing was injected. PURE given `env`.
 *
 * The env is the only source this package reads: a repository's `.red/config.yaml`
 * is the consumer's file, and a library that went looking for it would be a
 * second reader of a document the consumer already owns.
 */
export function githubBudgetGateFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GithubBudgetGateMode {
  return githubBudgetGate(env[GITHUB_BUDGET_GATE_ENV]);
}
