import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  auditDaemonBoundary,
  carriesDeathEvidence,
  DAEMON_BOUNDARY_ALLOWANCES,
  DAEMON_BOUNDARY_RULES,
  DEATH_EVIDENCE_ROOTS,
  readDaemonBoundaryFiles,
  staleDaemonBoundaryAllowances,
  type DaemonBoundaryFile,
} from "../src/core/daemon-death-evidence-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const LIVE_FILES: DaemonBoundaryFile[] = readDaemonBoundaryFiles(ROOT);

function posed(path: string, sourceText: string): DaemonBoundaryFile {
  return { path, sourceText };
}

describe("daemon death-evidence boundary — the daemon classifies, the checkout decides", () => {
  it("reaches the daemon tree, so a green sweep means something", () => {
    expect(LIVE_FILES.length).toBeGreaterThan(50);
    for (const root of DEATH_EVIDENCE_ROOTS) {
      expect(
        LIVE_FILES.some((file) => file.path.startsWith(`${root}/`)),
        `the sweep reached nothing under ${root}`,
      ).toBe(true);
    }
  });

  it("finds the death-evidence carriers by their vocabulary rather than by a hand-kept list", () => {
    const carriers = LIVE_FILES.filter(carriesDeathEvidence).map((file) => file.path);

    // The resolver that reads the receipt and the lane that carries the record
    // are the two the classification cannot exist without.
    expect(carriers).toContain("apps/redskilled/src/daemon/unit-death.ts");
    expect(carriers).toContain("apps/redskilled/src/event-lane.ts");
    expect(carriers.length).toBeGreaterThan(5);
  });

  it("holds the live daemon at the boundary", () => {
    expect(auditDaemonBoundary(LIVE_FILES)).toEqual([]);
  });

  it("keeps the allowance list honest — a survival that stopped surviving is pruned", () => {
    expect(staleDaemonBoundaryAllowances(LIVE_FILES)).toEqual([]);
    for (const allowance of DAEMON_BOUNDARY_ALLOWANCES) {
      expect(DAEMON_BOUNDARY_RULES.map((rule) => rule.family)).toContain(allowance.family);
      expect(allowance.reason.length).toBeGreaterThan(40);
    }
  });

  it("refuses an issue number the daemon taught itself to key on", () => {
    const file = posed(
      "apps/redskilled/src/daemon/invented.ts",
      "export function requeue(death: { sender_class: string; issue_number: number }) {\n  return death.issue_number;\n}\n",
    );

    const [finding] = auditDaemonBoundary([file]);

    expect(finding?.family).toBe("tracker-issue");
    expect(finding?.reason).toContain("worker_id");
  });

  it("refuses a triage label, which is a meaning the checkout owns", () => {
    const file = posed(
      "apps/redskilled/src/daemon/invented.ts",
      'const OOM_RETRY = "ready-for-agent";\nexport function requeue(sender_class: string) {\n  return sender_class === "oomd" ? OOM_RETRY : null;\n}\n',
    );

    const [finding] = auditDaemonBoundary([file]);

    expect(finding?.family).toBe("triage-label");
    expect(finding?.match).toBe("ready-for-agent");
  });

  it("refuses a tracker call, which is the recovery decision leaving its owner", () => {
    const file = posed(
      "apps/redskilled/src/daemon/invented.ts",
      'export async function onWorkerDeath(sender_class: string) {\n  await fetch("https://api.github.com/repos/acme/widgets/issues/7/labels");\n}\n',
    );

    const findings = auditDaemonBoundary([file]);

    expect(findings.map((finding) => finding.family)).toContain("tracker-call");
  });

  it("names the file and the line, so the refusal is actionable without a search", () => {
    const file = posed(
      "apps/redskilled/src/daemon/invented.ts",
      "const memoryPeakBytes = 1;\n\nexport const lane = \"ready-for-agent\";\n",
    );

    const [finding] = auditDaemonBoundary([file]);

    expect(finding?.path).toBe("apps/redskilled/src/daemon/invented.ts");
    expect(finding?.line).toBe(3);
  });

  it("reads prose as prose: an ADR reference explaining the boundary is not a crossing", () => {
    const file = posed(
      "apps/redskilled/src/daemon/invented.ts",
      "// ADR 0155: the daemon never learns which issue a Worker held, and never\n" +
        "// writes a `ready-for-agent` label. It emits `sender_class` and stops.\n" +
        "export const senderClass = null;\n",
    );

    expect(auditDaemonBoundary([file])).toEqual([]);
  });

  it("leaves a daemon file that carries no death evidence to the other ratchets", () => {
    const file = posed(
      "apps/redskilled/src/daemon/invented.ts",
      'export const queue = "ready-for-agent";\n',
    );

    expect(auditDaemonBoundary([file])).toEqual([]);
  });
});
