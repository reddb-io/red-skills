#!/usr/bin/env node
/**
 * Container entrypoint — the container is a HOST that runs `redskilled`.
 *
 * **The queue loop is the daemon's demand loop.** ADR 0150 §4 makes the
 * `redskilled` daemon the only thing that births a Worker, and a client that
 * finds no daemon fails closed rather than spawning one — so a container that
 * wants Workers has to BE a host with a daemon on it, not a bash-shaped loop
 * that shells out per issue. There is no init system in here, so this process
 * is the supervisor: it execs the shipped `red-skills-redskilled serve` as its
 * one long-lived child, clones each target repository once as that project's
 * workspace, registers the project through the daemon's own Project control
 * surface, and then follows the drain to completion.
 *
 * Everything the old lane did by hand — pick the queue head, clone per issue,
 * shell out to a per-issue run of the dev CLI — belonged to a binary #4031
 * deleted (#4118). The
 * daemon does all of it now: it polls the registration's query, births a Worker
 * per queued item with `@reddb-io/worker` (ADR 0148), briefs it, runs the gate,
 * publishes the commits and lands the pull request.
 *
 * State still lives on GitHub — the issue's labels and its claim/heartbeat/park
 * comments, plus the branch and the pull request. The container mounts no volume.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRunEnv, resolveConfig } from "./config.mjs";
import { awaitDaemonSession, startRedskilledDaemon } from "./daemon.mjs";
import { drainVerdict, nextBackoffSeconds } from "./drain.mjs";
import { openProjectSession } from "./acp.mjs";
import { redskilledInvocation, redSkillsVersion } from "./redskilled.mjs";
import { buildContainerRegistration } from "./registration.mjs";
import { selectRunner } from "./runners.mjs";

/** Live clone directories, so a SIGTERM mid-drain still leaves the filesystem clean. */
const liveWorkdirs = new Set();
let aborting = false;

function log(message) {
  process.stdout.write(`[afk-container] ${message}\n`);
}

/** Run a command with inherited stdio, resolving to its exit code. */
function inherit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
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
 * The project workspace the daemon materialises every Worker worktree from.
 *
 * A FULL clone, not a shallow one: the Worker's base is a fetched trunk commit
 * and its gate diffs against the merge base, both of which need real history.
 */
async function cloneProject(repo, env, workRoot) {
  const root = workRoot || tmpdir();
  const dir = await mkdtemp(join(root, `afk-${repo.replace("/", "-")}-`));
  liveWorkdirs.add(dir);
  await mustSucceed("git", ["clone", "--recurse-submodules", `https://github.com/${repo}.git`, dir], { env });
  return dir;
}

async function dropWorkdir(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  liveWorkdirs.delete(dir);
}

/**
 * Stop the daemon, drop the ephemeral clones, and leave. Every issue a Worker
 * held stays reclaimable: the claim goes stale and the daemon's own reclaim
 * hands it back to the queue on the next host that drains it.
 */
function installSignalHandlers(shutdown) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (aborting) return;
      aborting = true;
      log(`${signal} received — ending the drain; claimed issues stay reclaimable`);
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      shutdown(signal);
      setTimeout(() => process.exit(process.exitCode), 15_000).unref?.();
    });
  }
}

/**
 * Register one cloned project with the daemon and hand back its live session.
 *
 * The registration is authored here because rule 3 forbids the daemon from
 * learning what an Issue or a label is: it carries the query, the birth argv,
 * the workspace and the prompt, and reads none of them.
 */
async function registerProject({ repo, dir, config, runner, env }) {
  const session = await openProjectSession({
    spawn,
    argv: redskilledInvocation(env, ["acp"]),
    cwd: dir,
    env,
    name: "RedSkills container lane",
    version: redSkillsVersion(env),
    onLine: (line) => log(`acp[${repo}]: ${line}`),
  });
  const registration = buildContainerRegistration({
    repo,
    workspacePath: dir,
    target: config.target,
    readyLabel: config.label,
    ...(config.lane === "" ? {} : { lane: config.lane }),
    argv: redskilledInvocation(env, ["acp-worker", ...(runner ? ["--child-agent", runner] : [])]),
    trunkBranch: await trunkBranchOf(dir, env),
  });
  const answer = await session.drain({ target: config.target, runner, registration });
  if (answer?.warning) log(`${repo}: ${answer.warning}`);
  return { repo, dir, session };
}

/** The branch `origin/HEAD` points at, or `main` when git cannot say. */
async function trunkBranchOf(dir, env) {
  return await new Promise((resolve) => {
    const proc = spawn("git", ["-C", dir, "symbolic-ref", "refs/remotes/origin/HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("error", () => resolve("main"));
    proc.on("close", (code) => resolve(code === 0 ? (out.trim().split("/").pop() || "main") : "main"));
  });
}

export async function main(env = process.env) {
  let config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    process.stderr.write(`[afk-container] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const { runner, skipped } = selectRunner(config.cadence, 0, env);
  if (skipped.length > 0) log(`runner ${skipped.join(", ")} skipped — no credential in this environment`);
  if (!runner) {
    log(`no cadence runner is credentialed (cadence: ${config.cadence.join(", ")})`);
    return 2;
  }

  const runEnv = buildRunEnv(env, { token: config.token });
  await prepareGit(config, runEnv);

  log(`repos=${config.repos.join(",")} runner=${runner} target=${config.target} loop=${config.loop}`);

  const daemon = startRedskilledDaemon({
    spawn,
    argv: redskilledInvocation(env, ["serve"]),
    env: runEnv,
    log,
  });
  const projects = [];
  installSignalHandlers(() => {
    for (const project of projects) project.session.close();
    daemon.stop();
  });

  try {
    // One session proves the daemon is serving; the rest reuse the same host.
    await awaitDaemonSession({
      open: async () => {
        const probe = await openProjectSession({
          spawn,
          argv: redskilledInvocation(env, ["acp"]),
          cwd: process.cwd(),
          env: runEnv,
          name: "RedSkills container readiness probe",
          version: redSkillsVersion(env),
        });
        probe.close();
        return true;
      },
      sleep: (ms) => sleep(ms / 1000),
      daemon,
      log,
    });
    log("redskilled is serving");

    for (const repo of config.repos) {
      if (aborting) break;
      const dir = await cloneProject(repo, runEnv, config.workRoot);
      projects.push(await registerProject({ repo, dir, config, runner, env: runEnv }));
      log(`${repo}: registered at target ${config.target}; the daemon owns the queue from here`);
    }

    return await followDrain(projects, config);
  } catch (error) {
    process.stderr.write(`[afk-container] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    return 1;
  } finally {
    for (const project of projects) project.session.close();
    daemon.stop();
    for (const dir of [...liveWorkdirs]) await dropWorkdir(dir);
  }
}

/**
 * DECLARED WAIT — subject: every registered project's drain. Deadline:
 * unbounded, and deliberately so in loop mode; in one-shot mode it ends the
 * first time every project reports an empty queue with no Worker live.
 * Escalation: none is needed — the daemon reports the drain's own posture on
 * every poll, so a stall is visible in this process's output rather than
 * hiding behind a silent sleep.
 */
async function followDrain(projects, config) {
  let backoff = config.idleSeconds;
  for (;;) {
    if (aborting) return process.exitCode ?? 143;
    if (projects.length === 0) {
      log("no project registered — nothing to follow");
      return 0;
    }

    const verdicts = [];
    for (const project of projects) {
      const status = await project.session.status();
      const verdict = drainVerdict(status, { loop: config.loop });
      log(`${project.repo}: ${verdict.state} — ${verdict.detail}`);
      verdicts.push(verdict);
    }

    if (verdicts.some((verdict) => verdict.state === "unregistered")) {
      log("a registration lapsed and nothing polls its queue — ending the run");
      return 1;
    }
    if (!config.loop && verdicts.every((verdict) => verdict.state === "drained")) {
      log("every queue is drained and no Worker is live");
      return 0;
    }

    const idle = verdicts.every((verdict) => verdict.state === "idle");
    await sleep(idle ? backoff : config.pollSeconds);
    backoff = idle ? nextBackoffSeconds(backoff, config.maxIdleSeconds) : config.idleSeconds;
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
