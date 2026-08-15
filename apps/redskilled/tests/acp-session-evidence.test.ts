import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAcpSessionJournal,
  providerSessionEvidenceFromMeta,
  type AcpSessionRecoveryCheckpoint,
} from "../src/acp-session-journal.js";

const roots: string[] = [];
const project = (root: string, id = "github:3834") => ({
  projectId: id,
  projectLabel: id === "github:3834" ? "acme/widgets" : "acme/unrelated",
  checkoutRoot: join(root, "checkout"),
  workspacePath: join(root, "workspace"),
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("provider-native ACP session evidence", () => {
  it.each([
    { availability: "available" as const, reference: "provider-session:present" },
    { availability: "absent" as const, reference: undefined },
    { availability: "inaccessible" as const, reference: "provider-session:remote" },
  ])("keeps the public journal contract unchanged when evidence is $availability", async (report) => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-session-evidence-"));
    roots.push(root);
    const journal = await createAcpSessionJournal(join(root, "sessions.toon"));
    await journal.create("public-session", project(root));
    await journal.prompt("public-session", [{ type: "text", text: "continue from public history" }]);
    await journal.worker("public-session", "w3834", "worker-session", false);
    await journal.evidence("public-session", "w3834", {
      provider: "fixture-runner",
      ...report,
    });
    await journal.checkpoint("public-session", { stopReason: "end_turn" });

    expect(journal.recovery("public-session")).toEqual(publicRecovery());
  });

  it("retains available evidence after workspace reclamation and scopes /retake to its Project", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-session-retake-"));
    roots.push(root);
    const path = join(root, "sessions.toon");
    const journal = await createAcpSessionJournal(path);
    await journal.create("public-session", project(root));
    await journal.evidence("public-session", "w3834", {
      provider: "fixture-runner",
      availability: "available",
      reference: "provider-session:retained",
    });

    await rm(project(root).workspacePath, { recursive: true, force: true });
    const restarted = await createAcpSessionJournal(path);
    expect(restarted.retake("public-session", "github:3834")).toEqual({
      version: 1,
      public_session_id: "public-session",
      evidence: [{
        worker_id: "w3834",
        provider: "fixture-runner",
        reference: "provider-session:retained",
        availability: "available",
        retention: "evidence",
      }],
    });
    expect(restarted.retake("public-session", "github:9999")).toBeUndefined();
  });

  it("accepts only a provider report and assigns the retention class itself", () => {
    expect(providerSessionEvidenceFromMeta({
      redskills: {
        sessionEvidence: {
          provider: "fixture-runner",
          reference: "provider-session:opaque",
          availability: "inaccessible",
          retention: "workspace",
        },
      },
    })).toEqual({
      provider: "fixture-runner",
      reference: "provider-session:opaque",
      availability: "inaccessible",
    });
    expect(providerSessionEvidenceFromMeta(undefined)).toBeUndefined();
  });
});

function publicRecovery(): AcpSessionRecoveryCheckpoint {
  return {
    version: 1,
    source: "redskilled-public-journal",
    public_session_id: "public-session",
    completed_turns: 1,
    entries: [
      {
        sequence: 1,
        kind: "prompt",
        prompt: [{ type: "text", text: "continue from public history" }],
      },
      {
        sequence: 2,
        kind: "workflow-pointer",
        worker_id: "w3834",
        worker_session_id: "worker-session",
        replacement: false,
      },
      { sequence: 3, kind: "checkpoint", stop_reason: "end_turn" },
    ],
  };
}
