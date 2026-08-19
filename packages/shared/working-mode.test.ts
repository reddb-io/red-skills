import { describe, expect, it } from "vitest";
import {
  RED_MODE_ENV,
  WORKER_WORKING_MODES,
  WORKING_MODES,
  declaredWorkingMode,
  workerModeEnv,
  workingModeOfWorkerKind,
} from "./working-mode.js";

describe("the four Working modes", () => {
  it("stays the closed set ADR 0150 §1 declares, in the ADR's order", () => {
    expect([...WORKING_MODES]).toEqual(["interactive", "spec-driven", "ad-hoc", "ADR-editing"]);
  });

  it("names only the two a Worker can be in", () => {
    expect([...WORKER_WORKING_MODES]).toEqual(["spec-driven", "ad-hoc"]);
  });
});

describe("the mode a dispatch kind runs in", () => {
  it("calls the one ad-hoc entrance ad-hoc and every queue-driven one spec-driven", () => {
    expect(workingModeOfWorkerKind("go")).toBe("ad-hoc");
    expect(workingModeOfWorkerKind("afk")).toBe("spec-driven");
    expect(workingModeOfWorkerKind("scout")).toBe("spec-driven");
  });

  it("reads an untargeted birth as the drain's, because /go always names its Ticket", () => {
    expect(workingModeOfWorkerKind()).toBe("spec-driven");
  });
});

describe("the marker the daemon exports", () => {
  it("is one name carrying the mode, for both kinds of run", () => {
    expect(workerModeEnv("afk")).toEqual({ [RED_MODE_ENV]: "spec-driven" });
    expect(workerModeEnv("go")).toEqual({ [RED_MODE_ENV]: "ad-hoc" });
  });

  it("reads back the mode a Worker was born in", () => {
    expect(declaredWorkingMode({ RED_MODE: "ad-hoc" })).toBe("ad-hoc");
    expect(declaredWorkingMode({ RED_MODE: " spec-driven " })).toBe("spec-driven");
  });

  it("says nothing rather than guessing when the marker is absent or unknown", () => {
    expect(declaredWorkingMode({})).toBeUndefined();
    expect(declaredWorkingMode({ RED_MODE: "" })).toBeUndefined();
    expect(declaredWorkingMode({ RED_MODE: "autonomous" })).toBeUndefined();
  });
});
