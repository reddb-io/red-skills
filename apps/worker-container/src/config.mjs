/**
 * Environment contract for the container lane.
 *
 * Every knob is an env var — the image carries no config file and no state, so
 * `docker run -e …` is the whole interface. What the container decides is
 * narrow by design: which repositories to drain, which label defines "queued",
 * which coder Agent a Worker runs and how wide the drain goes. Everything else
 * — which issue is next, when a Worker is born, what it is briefed with, when
 * it lands — belongs to the daemon that ADR 0150 §4 makes the sole birth
 * authority.
 */

import { parseCadence } from "./runners.mjs";

const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const DEFAULT_LABEL = "ready-for-agent";
const DEFAULT_IDLE_SECONDS = 60;
const DEFAULT_MAX_IDLE_SECONDS = 900;
const DEFAULT_POLL_SECONDS = 15;
const DEFAULT_TARGET = 1;

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
    /** An optional `lane:<x>` narrowing, expressed in the query the daemon polls. */
    lane: trimmed(env.RED_AFK_QUEUE_LANE),
    loop: isTrue(env.RED_AFK_LOOP),
    idleSeconds,
    maxIdleSeconds,
    /** How often this container asks the daemon where its drain stands. */
    pollSeconds: positiveInt(env.RED_AFK_POLL_SECONDS, DEFAULT_POLL_SECONDS),
    /** The width asked for; the host still decides how many Workers it grants. */
    target: positiveInt(env.RED_AFK_TARGET, DEFAULT_TARGET),
    workRoot: trimmed(env.RED_AFK_WORK_ROOT),
    gitUserName: trimmed(env.GIT_AUTHOR_NAME) || "afk-container[bot]",
    gitUserEmail: trimmed(env.GIT_AUTHOR_EMAIL) || "afk-container@users.noreply.github.com",
  };
}

/**
 * The environment the daemon — and through it every Worker — inherits.
 *
 * The container carries no sandbox knob any more: the container IS the sandbox,
 * and the daemon's placement already reports the isolation it could not get
 * rather than nesting a second one. `RED_AFK_LANE=container` tags the run for
 * observability and nothing reads it as a decision.
 */
export function buildRunEnv(env, overrides = {}) {
  const runEnv = { ...env, RED_AFK_LANE: "container" };
  if (overrides.token) runEnv.GH_TOKEN = overrides.token;
  return runEnv;
}
