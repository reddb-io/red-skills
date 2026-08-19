/**
 * Environment contract for the AFK container lane.
 *
 * Every knob is an env var — the image carries no config file and no state, so
 * `docker run -e …` is the whole interface. The engine keeps its own precedence
 * rules; this module only decides what reaches it.
 */

import { parseCadence } from "./runners.mjs";

const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const DEFAULT_LABEL = "ready-for-agent";
const DEFAULT_IDLE_SECONDS = 60;
const DEFAULT_MAX_IDLE_SECONDS = 900;

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(raw, fallback) {
  const parsed = Number.parseInt(trimmed(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTrue(raw) {
  return trimmed(raw).toLowerCase() === "true";
}

/** Parse `RED_AFK_TARGET_REPOS` — one `owner/name` slug, or a comma-separated list of them. */
export function parseTargetRepos(raw) {
  const repos = trimmed(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (repos.length === 0) {
    throw new Error("RED_AFK_TARGET_REPOS is required (one `owner/name` slug, or a comma-separated list)");
  }
  const malformed = repos.filter((repo) => !REPO_SLUG.test(repo));
  if (malformed.length > 0) {
    throw new Error(`RED_AFK_TARGET_REPOS holds malformed repo slug(s): ${malformed.join(", ")} (want "owner/name")`);
  }
  return repos;
}

/** Resolve the whole runtime configuration from the process environment. Throws on a missing requirement. */
export function resolveConfig(env) {
  const token = trimmed(env.GH_TOKEN) || trimmed(env.GITHUB_TOKEN);
  if (!token) throw new Error("GH_TOKEN (or GITHUB_TOKEN) is required to read the queue and open pull requests");

  const idleSeconds = positiveInt(env.RED_AFK_LOOP_IDLE_SECONDS, DEFAULT_IDLE_SECONDS);
  const maxIdleSeconds = Math.max(idleSeconds, positiveInt(env.RED_AFK_LOOP_MAX_IDLE_SECONDS, DEFAULT_MAX_IDLE_SECONDS));

  return {
    token,
    repos: parseTargetRepos(env.RED_AFK_TARGET_REPOS),
    cadence: parseCadence(env.RED_AFK_RUNNER_CADENCE),
    label: trimmed(env.RED_AFK_QUEUE_LABEL) || DEFAULT_LABEL,
    loop: isTrue(env.RED_AFK_LOOP),
    idleSeconds,
    maxIdleSeconds,
    model: trimmed(env.RED_AFK_MODEL),
    effort: trimmed(env.RED_AFK_EFFORT),
    workRoot: trimmed(env.RED_AFK_WORK_ROOT),
    gitUserName: trimmed(env.GIT_AUTHOR_NAME) || "afk-container[bot]",
    gitUserEmail: trimmed(env.GIT_AUTHOR_EMAIL) || "afk-container@users.noreply.github.com",
  };
}

/**
 * The environment the engine child inherits.
 *
 * `RED_AFK_SANDBOX=none` unconditionally: the container IS the sandbox, so a
 * target repo configured for docker/podman must not nest another one. An empty
 * model/effort override is deleted rather than passed as `""`, leaving the target
 * repo's `.red/config.yaml` in charge — the same contract as the Actions lane.
 */
export function buildRunEnv(env, overrides = {}) {
  const runEnv = { ...env, RED_AFK_SANDBOX: "none", RED_AFK_LANE: "container" };

  if (overrides.token) runEnv.GH_TOKEN = overrides.token;

  const model = trimmed(overrides.model);
  const effort = trimmed(overrides.effort);
  if (model) runEnv.RED_AFK_MODEL = model;
  else delete runEnv.RED_AFK_MODEL;
  if (effort) runEnv.RED_AFK_EFFORT = effort;
  else delete runEnv.RED_AFK_EFFORT;

  return runEnv;
}

/** Exponential idle backoff for loop mode, capped at `ceiling`. */
export function nextBackoffSeconds(current, ceiling) {
  return Math.min(ceiling, current * 2);
}
