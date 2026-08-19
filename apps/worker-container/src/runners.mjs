/**
 * Runner cadence + credential policy for the AFK container lane.
 *
 * The container drives the SAME engine runners as every other AFK lane
 * (`red-skills-dev run --runner <id>`). This module owns only two decisions:
 * which runner a given run uses (round-robin over the cadence) and whether that
 * runner has a credential to use at all (fallback when it does not).
 *
 * `claude-minimax` is deliberately absent from `DEFAULT_CADENCE`: MiniMax-M3 does
 * not reliably emit the DONE sentinel, so it is the evaluation lane, entered only
 * when an operator names it in `RED_AFK_RUNNER_CADENCE`.
 */

/** Every runner id the engine's `--runner` flag accepts on this lane. */
export const KNOWN_RUNNERS = Object.freeze(["claude", "codex", "opencode", "claude-minimax"]);

/** The cadence used when `RED_AFK_RUNNER_CADENCE` is unset. Never includes claude-minimax. */
export const DEFAULT_CADENCE = Object.freeze(["claude", "codex", "opencode"]);

/**
 * Credential env vars per runner, in the engine's own precedence order. A runner
 * is credentialed when ANY of its vars carries a non-blank value: opencode reads
 * the first set key of OPENAI_API_KEY > MINIMAX_API_KEY > OPENROUTER_API_KEY
 * (opencode-env.ts), and the claude CLI accepts either an API key or an OAuth token.
 */
export const RUNNER_CREDENTIAL_ENVS = Object.freeze({
  claude: Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
  codex: Object.freeze(["OPENAI_API_KEY"]),
  opencode: Object.freeze(["OPENAI_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY"]),
  "claude-minimax": Object.freeze(["MINIMAX_API_KEY"]),
});

/**
 * Parse `RED_AFK_RUNNER_CADENCE` into an ordered, de-duplicated runner list.
 * Blank/unset yields `DEFAULT_CADENCE`. An unknown id throws rather than being
 * dropped — a typo'd cadence must not silently degrade to a different runner.
 */
export function parseCadence(raw) {
  const listed = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length === 0) return [...DEFAULT_CADENCE];

  const unknown = listed.filter((runner) => !KNOWN_RUNNERS.includes(runner));
  if (unknown.length > 0) {
    throw new Error(
      `unknown runner(s) in RED_AFK_RUNNER_CADENCE: ${unknown.join(", ")} (known: ${KNOWN_RUNNERS.join(", ")})`,
    );
  }
  return [...new Set(listed)];
}

function isSet(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** The credential env vars a runner would need but does not have in `env`. */
export function missingCredentialEnvs(runner, env) {
  const candidates = RUNNER_CREDENTIAL_ENVS[runner] ?? [];
  return candidates.filter((name) => !isSet(env[name]));
}

/** True when at least one of the runner's credential env vars carries a value. */
export function hasCredential(runner, env) {
  const candidates = RUNNER_CREDENTIAL_ENVS[runner] ?? [];
  return candidates.some((name) => isSet(env[name]));
}

/**
 * Pick the runner for run number `cycle`: start at `cycle % cadence.length` and
 * walk forward (wrapping once) to the first credentialed entry. Fallback stays
 * inside the cadence, so a runner an operator never listed — claude-minimax in
 * particular — can never be reached by a missing-credential fallback.
 *
 * @returns {{ runner: string|null, skipped: string[] }} `runner: null` when no
 * cadence entry is credentialed; `skipped` names the entries passed over.
 */
export function selectRunner(cadence, cycle, env) {
  if (!Array.isArray(cadence) || cadence.length === 0) {
    throw new Error("selectRunner: cadence must be a non-empty runner list");
  }
  const size = cadence.length;
  const start = ((cycle % size) + size) % size;
  const skipped = [];
  for (let step = 0; step < size; step += 1) {
    const runner = cadence[(start + step) % size];
    if (hasCredential(runner, env)) return { runner, skipped };
    skipped.push(runner);
  }
  return { runner: null, skipped };
}
