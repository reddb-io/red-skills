#!/usr/bin/env node
/**
 * AFK-in-a-box entrypoint.
 *
 * Reads the target repos from the environment, drains one `ready-for-agent` issue
 * per run through the existing AFK engine, and exits 0. `RED_AFK_LOOP=true` repeats
 * with an exponential idle backoff instead of exiting on an empty queue.
 *
 * State lives on GitHub — the issue's labels and its claim/heartbeat/park comments,
 * plus the run branch. The container mounts no volume and writes nothing it keeps.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCycle } from "./attempt.mjs";
import { buildRunEnv, nextBackoffSeconds, resolveConfig } from "./config.mjs";
import { listReadyIssues } from "./queue.mjs";

const ENGINE_BIN = "red-skills-dev";

/** Live clone directories, so a SIGTERM mid-run still leaves the filesystem clean. */
const liveWorkdirs = new Set();
let child = null;
let aborting = false;

function log(message) {
  process.stdout.write(`[afk-container] ${message}\n`);
}

/** Run a command to completion, capturing its output (used for `gh` queries). */
function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run a command with inherited stdio, resolving to its exit code. */
function inherit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: "inherit" });
    child = proc;
    proc.on("error", reject);
    proc.on("close", (code) => {
      child = null;
      resolve(code ?? 1);
    });
  });
}

async function mustSucceed(command, args, options = {}) {
  const code = await inherit(command, args, options);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${code}`);
}

/**
 * Give git a committer identity, a token-backed credential helper, and an HTTPS
 * rewrite for SSH submodule URLs (a repo vendoring `git@github.com:` submodules
 * cannot resolve them here — the container carries no SSH key).
 */
async function prepareGit(config, env) {
  await mustSucceed("git", ["config", "--global", "user.name", config.gitUserName], { env });
  await mustSucceed("git", ["config", "--global", "user.email", config.gitUserEmail], { env });
  await mustSucceed("git", ["config", "--global", "url.https://github.com/.insteadOf", "git@github.com:"], { env });
  await mustSucceed("gh", ["auth", "setup-git"], { env });
}

function makeIo(env) {
  return {
    listIssues: ({ repo, label }) => listReadyIssues({ repo, label, exec: (cmd, args) => capture(cmd, args, { env }) }),

    async makeWorkdir({ repo }) {
      const root = env.RED_AFK_WORK_ROOT || tmpdir();
      const dir = await mkdtemp(join(root, `afk-${repo.replace("/", "-")}-`));
      liveWorkdirs.add(dir);
      return dir;
    },

    // A full clone, not a shallow one: the engine diffs the run branch against the
    // merge base and the validation gate needs real history.
    clone: ({ repo, dir }) =>
      mustSucceed("git", ["clone", "--recurse-submodules", `https://github.com/${repo}.git`, dir], { env }),

    // The SAME engine path every other AFK lane uses. It claims, heartbeats,
    // validates, and opens the pull request.
    runEngine: ({ dir, issue, runner, env: runEnv }) =>
      inherit(ENGINE_BIN, ["run", "--issues", String(issue), "--runner", runner, "--once"], { cwd: dir, env: runEnv }),

    async cleanup(dir) {
      await rm(dir, { recursive: true, force: true });
      liveWorkdirs.delete(dir);
    },
  };
}

function sleep(seconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    timer.unref?.();
    // A shutdown signal must not wait out the backoff.
    const poll = setInterval(() => {
      if (aborting) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 250);
    poll.unref?.();
  });
}

/**
 * Kill the engine, drop the ephemeral clones, and leave. The issue keeps its claim
 * comment; the engine's stale-claim reconciliation hands it back to the queue.
 */
function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (aborting) return;
      aborting = true;
      log(`${signal} received — abandoning the run; the issue stays reclaimable by stale-claim reconciliation`);
      child?.kill(signal);
      for (const dir of liveWorkdirs) {
        try {
          rm(dir, { recursive: true, force: true });
        } catch {
          // best effort — the container is going away anyway
        }
      }
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      setTimeout(() => process.exit(process.exitCode), 5_000).unref?.();
    });
  }
}

export async function main(env = process.env) {
  let config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    process.stderr.write(`[afk-container] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  installSignalHandlers();
  await prepareGit(config, buildRunEnv(env, { token: config.token }));

  log(`repos=${config.repos.join(",")} cadence=${config.cadence.join(",")} loop=${config.loop}`);

  let cycle = 0;
  let backoff = config.idleSeconds;

  for (;;) {
    if (aborting) return process.exitCode ?? 143;

    const outcome = await runCycle({ config, cycle, env, io: makeIo(env), log });
    cycle += 1;

    if (outcome.status === "no-runner") return 2;

    if (outcome.status === "empty") {
      if (!config.loop) {
        log("queue empty — nothing to do");
        return 0;
      }
      log(`queue empty — sleeping ${backoff}s`);
      await sleep(backoff);
      backoff = nextBackoffSeconds(backoff, config.maxIdleSeconds);
      continue;
    }

    log(`${outcome.repo}#${outcome.issue}: engine exited ${outcome.exitCode} (runner ${outcome.runner})`);
    backoff = config.idleSeconds;
    // One-shot mode surfaces the engine's own verdict; loop mode keeps draining.
    if (!config.loop) return outcome.status === "worked" ? 0 : (outcome.exitCode ?? 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[afk-container] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exit(1);
    });
}
