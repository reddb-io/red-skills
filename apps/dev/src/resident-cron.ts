import * as fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, type JsonValue } from "@reddb-io/toon";
import { serialize as encode } from "@reddb-io/toon/legacy";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
  type SingletonEventLane,
  type SingletonLeaseAcquireResult,
  type SingletonLeaseOwner,
  type SingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import { resolveRepoRoot } from "@reddb-io/shared/repo-root.js";
import { readPidStartTime } from "./core/state.js";

export interface ResidentCronSchedule {
  readonly last_fired_at?: string;
  readonly next_due_at: string;
  readonly interval_ms: number;
}

export interface ResidentCronFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8" },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
}

export interface ResidentCronTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface ResidentCronOptions {
  readonly root: string;
  readonly name: string;
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
  readonly fs?: ResidentCronFs;
  readonly clock?: () => Date;
  readonly timers?: ResidentCronTimers;
  readonly lane?: SingletonEventLane;
  readonly notice?: (message: string) => void;
}

export interface ResidentCron {
  start(): Promise<void>;
  tick(): Promise<boolean>;
  stop(): Promise<void>;
  schedule(): ResidentCronSchedule | undefined;
}

export const RESIDENT_JANITOR_INTERVAL_MS = 5 * 60 * 1000;
export const RESIDENT_CRON_EVENT_KIND = "resident.cron";
export const JANITOR_SWEEP_EVENT_KIND = "janitor.sweep";

export interface ResidentJanitorOptions {
  readonly root: string;
  readonly sweep: () => Promise<void>;
  readonly intervalMs?: number;
  readonly owner?: SingletonLeaseOwner;
  readonly leases?: SingletonLeaseStore;
  readonly lane?: SingletonEventLane;
  readonly fs?: ResidentCronFs;
  readonly clock?: () => Date;
  readonly timers?: ResidentCronTimers;
  readonly notice?: (message: string) => void;
}

export interface ResidentJanitor {
  start(): Promise<SingletonLeaseAcquireResult>;
  stop(): Promise<void>;
}

const CRON_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function assertOptions(options: ResidentCronOptions): void {
  if (!CRON_NAME_RE.test(options.name)) {
    throw new Error(
      `invalid resident cron name ${JSON.stringify(options.name)}`,
    );
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("resident cron intervalMs must be a positive integer");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validateSchedule(value: unknown): ResidentCronSchedule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("resident cron schedule must be a record");
  }
  const schedule = value as Record<string, unknown>;
  if (
    typeof schedule.next_due_at !== "string" ||
    !Number.isFinite(Date.parse(schedule.next_due_at))
  ) {
    throw new Error("resident cron next_due_at must be an ISO timestamp");
  }
  if (
    !Number.isSafeInteger(schedule.interval_ms) ||
    (schedule.interval_ms as number) <= 0
  ) {
    throw new Error("resident cron interval_ms must be a positive integer");
  }
  if (
    schedule.last_fired_at !== undefined &&
    (typeof schedule.last_fired_at !== "string" ||
      !Number.isFinite(Date.parse(schedule.last_fired_at)))
  ) {
    throw new Error("resident cron last_fired_at must be an ISO timestamp");
  }
  return {
    ...(schedule.last_fired_at === undefined
      ? {}
      : { last_fired_at: schedule.last_fired_at as string }),
    next_due_at: schedule.next_due_at,
    interval_ms: schedule.interval_ms as number,
  };
}

function nextCadence(
  scheduledFor: string,
  intervalMs: number,
  nowMs: number,
): string {
  let nextMs = Date.parse(scheduledFor) + intervalMs;
  if (nextMs <= nowMs) {
    const missed = Math.floor((nowMs - nextMs) / intervalMs) + 1;
    nextMs += missed * intervalMs;
  }
  return new Date(nextMs).toISOString();
}

export function residentCronSchedulePath(root: string, name: string): string {
  if (!CRON_NAME_RE.test(name)) {
    throw new Error(`invalid resident cron name ${JSON.stringify(name)}`);
  }
  const paths = createEnginePaths(join(root, ".red"));
  return join(paths.castleStateRoot, "crons", `${name}.toon`);
}

export function createResidentCron(options: ResidentCronOptions): ResidentCron {
  assertOptions(options);
  const fs =
    options.fs ??
    ({
      mkdir: fsPromises.mkdir,
      readFile: fsPromises.readFile,
      rename: fsPromises.rename,
      writeFile: fsPromises.writeFile,
    } satisfies ResidentCronFs);
  const clock = options.clock ?? (() => new Date());
  const timers =
    options.timers ??
    ({
      setInterval(callback, intervalMs) {
        const timer = setInterval(callback, intervalMs);
        timer.unref();
        return timer;
      },
      clearInterval(timer) {
        clearInterval(timer as NodeJS.Timeout);
      },
    } satisfies ResidentCronTimers);
  const notice = options.notice ?? (() => undefined);
  const path = residentCronSchedulePath(options.root, options.name);
  let current: ResidentCronSchedule | undefined;
  let timer: unknown;
  let running: Promise<boolean> | undefined;

  async function readSchedule(): Promise<ResidentCronSchedule | undefined> {
    try {
      return validateSchedule(decode(await fs.readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async function writeSchedule(schedule: ResidentCronSchedule): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(
      temporary,
      encode(schedule as unknown as JsonValue, { keyedMapCollapse: true }),
      { encoding: "utf8" },
    );
    await fs.rename(temporary, path);
  }

  async function runTick(): Promise<boolean> {
    if (!current) return false;
    const now = clock();
    const scheduledFor = current.next_due_at;
    if (now.getTime() < Date.parse(scheduledFor)) return false;

    let status = "passed";
    try {
      await options.run();
    } catch (error) {
      status = "failed";
      notice(
        `cron ${options.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    current = {
      last_fired_at: now.toISOString(),
      next_due_at: nextCadence(scheduledFor, options.intervalMs, now.getTime()),
      interval_ms: options.intervalMs,
    };
    await writeSchedule(current);
    if (options.lane) {
      await options.lane
        .append({
          singleton: options.name,
          kind: RESIDENT_CRON_EVENT_KIND,
          payload: {
            status,
            scheduled_for: scheduledFor,
            next_due_at: current.next_due_at,
            catch_up: now.getTime() > Date.parse(scheduledFor),
          },
        })
        .catch(() => notice(`cron ${options.name} event append failed`));
    }
    return true;
  }

  const cron: ResidentCron = {
    async start() {
      if (timer !== undefined) return;
      current = await readSchedule();
      if (!current) {
        current = {
          next_due_at: clock().toISOString(),
          interval_ms: options.intervalMs,
        };
        await writeSchedule(current);
      }
      timer = timers.setInterval(() => {
        void cron
          .tick()
          .catch((error) =>
            notice(
              `cron ${options.name} tick failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
      }, options.intervalMs);
      void cron
        .tick()
        .catch((error) =>
          notice(
            `cron ${options.name} tick failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    },

    tick() {
      if (running) return running;
      running = runTick().finally(() => {
        running = undefined;
      });
      return running;
    },

    async stop() {
      if (timer !== undefined) {
        timers.clearInterval(timer);
        timer = undefined;
      }
      await running?.catch((error) =>
        notice(
          `cron ${options.name} drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    },

    schedule() {
      return current;
    },
  };

  return cron;
}

export function createResidentJanitor(
  options: ResidentJanitorOptions,
): ResidentJanitor {
  const root = resolveRepoRoot(options.root);
  const paths = createEnginePaths(join(root, ".red"));
  const leases = options.leases ?? createSingletonLeaseStore(paths);
  const lane = options.lane ?? createSingletonEventLane(paths);
  const notice = options.notice ?? (() => undefined);
  const owner = options.owner ?? {
    pid: process.pid,
    startTime: readPidStartTime(process.pid) ?? `pid-${process.pid}`,
  };
  let ownsLease = false;

  const cron = createResidentCron({
    root,
    name: "janitor",
    intervalMs: options.intervalMs ?? RESIDENT_JANITOR_INTERVAL_MS,
    fs: options.fs,
    clock: options.clock,
    timers: options.timers,
    lane,
    notice,
    run: async () => {
      let status = "passed";
      let failure: unknown;
      try {
        await options.sweep();
      } catch (error) {
        status = "failed";
        failure = error;
      }
      await lane
        .append({
          singleton: "janitor",
          kind: JANITOR_SWEEP_EVENT_KIND,
          payload: {
            status,
            ...(failure === undefined
              ? {}
              : {
                  error:
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                }),
          },
        })
        .catch(() => notice("janitor sweep event append failed"));
      if (failure !== undefined) throw failure;
    },
  });

  return {
    async start() {
      const acquired = await leases.acquire("janitor", owner);
      if (!acquired.acquired) return acquired;
      ownsLease = true;
      try {
        await cron.start();
      } catch (error) {
        await leases.release("janitor", owner);
        ownsLease = false;
        throw error;
      }
      return acquired;
    },

    async stop() {
      if (!ownsLease) return;
      try {
        await cron.stop();
      } finally {
        await leases.release("janitor", owner);
        ownsLease = false;
      }
    },
  };
}
