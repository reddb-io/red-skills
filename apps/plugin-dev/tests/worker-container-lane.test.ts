/**
 * The container lane names a command the repository SHIPS, and briefs its
 * Workers the way every other drain does (#4118).
 *
 * `apps/worker-container` shelled out to `red-skills-dev run --issues N`, a
 * binary #4031 deleted with its 36-command router, so every container run died
 * at command-not-found before it reached a queue. Nothing failed when that
 * binary went away, because the container is plain `.mjs` no type checker reads
 * and no import graph reaches — which is exactly the shape a stale command name
 * survives in.
 *
 * So the obligation is checked from the `bin` map, the same source of truth the
 * shipped-binary guard discovers from: a binary is added by writing one line
 * there, and a lane that names something ABSENT from it is naming a command no
 * installation has.
 *
 * The second half pins the two things the container had to RESTATE because the
 * image carries no repository source and no workspace `node_modules`: the
 * Worker prompt, and the ACP wire it speaks. A mirror nobody pins is a second
 * contract nobody wrote down.
 *
 * The container modules are imported through a computed specifier so this suite
 * RUNS them — a source scan would pass on a constant that never loads — while
 * staying out of the type checker's graph, which is what `.mjs` beside `.ts` is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  collectDeclaredBinaries,
  readBinaryPackageManifests,
} from "../src/core/shipped-binary-guard.js";
import { DRAIN_WORKER_PROMPT } from "../src/core/drain-registration.js";
import { DEV_CLI_BINARY } from "../src/core/bare-invocation-guard.js";
import { REDSKILLS_ACP_METHODS, REDSKILLS_WIRE_MAJOR } from "@reddb-io/protocol-acp";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONTAINER_SRC = join(ROOT, "apps", "worker-container", "src");

/** Every module the container ships, so a new one inherits the sweep below. */
const CONTAINER_MODULES = [
  "acp.mjs",
  "config.mjs",
  "daemon.mjs",
  "drain.mjs",
  "entrypoint.mjs",
  "protocol.mjs",
  "redskilled.mjs",
  "registration.mjs",
  "runners.mjs",
];

const read = (file: string): string => readFileSync(join(CONTAINER_SRC, file), "utf8");

const load = (file: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(join(CONTAINER_SRC, file)).href) as Promise<Record<string, unknown>>;

describe("the container lane runs a Worker body that exists (#4118)", () => {
  let redskilled: Record<string, unknown>;
  let registration: Record<string, unknown>;
  let protocol: Record<string, unknown>;

  beforeAll(async () => {
    [redskilled, registration, protocol] = await Promise.all([
      load("redskilled.mjs"),
      load("registration.mjs"),
      load("protocol.mjs"),
    ]);
  });

  it("names a binary some workspace `bin` map declares", () => {
    const declared = collectDeclaredBinaries(readBinaryPackageManifests(ROOT));

    expect(declared.map((binary) => binary.name)).toContain(redskilled.REDSKILLED_BINARY);
  });

  it("names it out of the package an npx run can resolve", () => {
    const declared = collectDeclaredBinaries(readBinaryPackageManifests(ROOT))
      .find((binary) => binary.name === redskilled.REDSKILLED_BINARY);
    const manifest = JSON.parse(readFileSync(join(ROOT, declared!.declaredIn), "utf8"));

    expect(manifest.name).toBe(redskilled.RED_SKILLS_PACKAGE);
    expect(manifest.private).not.toBe(true);
  });

  it("runs that binary in the canonical pinned form unless the host declares a warm cache", () => {
    const invoke = redskilled.redskilledInvocation as (
      env: Record<string, string>,
      args: string[],
    ) => string[];

    expect(invoke({ RED_SKILLS_VERSION: "4.1.15" }, ["serve"])).toEqual([
      "npx", "-y", "-p", "@reddb-io/red-skills@4.1.15", redskilled.REDSKILLED_BINARY, "serve",
    ]);
    expect(invoke({ RED_SKILLS_INVOCATION: "path" }, ["acp-worker"]))
      .toEqual([redskilled.REDSKILLED_BINARY, "acp-worker"]);
  });

  it("spells no deleted execution-chain binary anywhere in its source", () => {
    for (const file of CONTAINER_MODULES) {
      expect(read(file), `${file} names the deleted dev CLI`).not.toContain(DEV_CLI_BINARY);
    }
  });

  it("briefs its Workers with the same prompt every other drain does", () => {
    expect(registration.CONTAINER_WORKER_PROMPT).toBe(DRAIN_WORKER_PROMPT);
  });

  it("restates the ACP wire the daemon actually speaks", () => {
    expect(protocol.REDSKILLS_WIRE_MAJOR).toBe(REDSKILLS_WIRE_MAJOR);
    expect(protocol.REDSKILLS_ACP_METHODS).toEqual({
      projectDrain: REDSKILLS_ACP_METHODS.projectDrain,
      projectStop: REDSKILLS_ACP_METHODS.projectStop,
      projectStatus: REDSKILLS_ACP_METHODS.projectStatus,
    });
  });
});
