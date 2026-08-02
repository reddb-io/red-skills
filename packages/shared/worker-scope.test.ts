// The scope a process was born into, as the process itself can read it.
import { describe, expect, it } from "vitest";
import {
  UNSCOPED_PROCESS,
  WORKER_SCOPE_CEILING_ENV,
  WORKER_SCOPE_DEGRADATION_ENV,
  WORKER_SCOPE_ENV,
  readWorkerScopeFacts,
  workerScopeEnvironment,
} from "./worker-scope.js";

describe("worker scope facts", () => {
  it("reads the scope and the ceiling the birth stated", () => {
    const facts = readWorkerScopeFacts({
      [WORKER_SCOPE_ENV]: "red-worker-red-skills-w1.service",
      [WORKER_SCOPE_CEILING_ENV]: "4294967296",
    });
    expect(facts).toEqual({
      scope: "red-worker-red-skills-w1.service",
      memory_ceiling: "4294967296",
      scope_degradation: null,
    });
  });

  it("reads a host that could not scope the birth as unscoped WITH the reason", () => {
    const facts = readWorkerScopeFacts({
      [WORKER_SCOPE_DEGRADATION_ENV]: "systemd-run is not on PATH",
    });
    expect(facts.scope).toBeNull();
    expect(facts.memory_ceiling).toBeNull();
    expect(facts.scope_degradation).toBe("systemd-run is not on PATH");
  });

  it("reads a process nobody stated anything about as wholly unscoped", () => {
    expect(readWorkerScopeFacts({})).toEqual(UNSCOPED_PROCESS);
  });

  it("treats a blank value as absent rather than as an empty scope", () => {
    expect(readWorkerScopeFacts({ [WORKER_SCOPE_ENV]: "   " })).toEqual(UNSCOPED_PROCESS);
  });

  it("round-trips the facts it hands a Worker, omitting the ones it has none of", () => {
    const environment = workerScopeEnvironment({
      scope: "red-worker-p-w.service",
      memory_ceiling: "1G",
      scope_degradation: null,
    });
    expect(environment).toEqual({
      [WORKER_SCOPE_ENV]: "red-worker-p-w.service",
      [WORKER_SCOPE_CEILING_ENV]: "1G",
    });
    expect(readWorkerScopeFacts(environment)).toEqual({
      scope: "red-worker-p-w.service",
      memory_ceiling: "1G",
      scope_degradation: null,
    });
  });

  it("hands a degraded birth its degradation, so the Worker can say it out loud", () => {
    const environment = workerScopeEnvironment({
      scope: null,
      memory_ceiling: null,
      scope_degradation: "no systemd --user session",
    });
    expect(environment).toEqual({ [WORKER_SCOPE_DEGRADATION_ENV]: "no systemd --user session" });
  });
});
