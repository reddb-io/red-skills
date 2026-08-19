import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_REF_FILE,
  FAILURE_REASON_FILE,
  formatPrevFailureContext,
  readPrevFailureContext,
  type PrevFailureReader,
} from "../src/core/prev-failure.js";

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "afk-prev-failure-"));
}

interface MakeWorkspace {
  namespace?: string;
  worker: string;
  issue: number;
  reason?: string;
  envelopeRef?: string;
}

async function mkWorkspace(
  root: string,
  { namespace = "workers", worker, issue, reason, envelopeRef }: MakeWorkspace,
): Promise<string> {
  const dir = join(root, namespace, worker, String(issue));
  await mkdir(dir, { recursive: true });
  if (reason !== undefined) await writeFile(join(dir, FAILURE_REASON_FILE), `${reason}\n`, "utf8");
  if (envelopeRef !== undefined) await writeFile(join(dir, ENVELOPE_REF_FILE), `${envelopeRef}\n`, "utf8");
  return dir;
}

describe("readPrevFailureContext — the ONE ADR 0103 carry-forward", () => {
  it("returns null when no worker workspace exists for the issue", async () => {
    const root = await tmpRoot();
    expect(await readPrevFailureContext(root, 249)).toBeNull();
  });

  it("returns null when the workspace exists but recorded no failure reason", async () => {
    const root = await tmpRoot();
    await mkWorkspace(root, { worker: "wA1B9", issue: 249 });
    expect(await readPrevFailureContext(root, 249)).toBeNull();
  });

  it("reads the failure reason and envelope reference from the issue workspace", async () => {
    const root = await tmpRoot();
    await mkWorkspace(root, {
      worker: "wA1B9",
      issue: 249,
      reason: "blocked: gate red",
      envelopeRef: "https://github.com/o/r/issues/249",
    });
    expect(await readPrevFailureContext(root, 249)).toEqual({
      reason: "blocked: gate red",
      envelopeRef: "https://github.com/o/r/issues/249",
    });
  });

  it("finds the workspace in every worker lane, not just `workers`", async () => {
    const root = await tmpRoot();
    await mkWorkspace(root, { namespace: "go-workers", worker: "wGO01", issue: 77, reason: "merge-conflict" });
    expect(await readPrevFailureContext(root, 77)).toEqual({ reason: "merge-conflict" });
  });

  it("ignores other issues and invalid worker ids", async () => {
    const root = await tmpRoot();
    await mkWorkspace(root, { worker: "wA1B9", issue: 250, reason: "other issue" });
    await mkWorkspace(root, { worker: "not a worker id", issue: 249, reason: "junk lane" });
    expect(await readPrevFailureContext(root, 249)).toBeNull();
  });

  it("prefers the most recently written reason when several workers tried the issue", async () => {
    const root = await tmpRoot();
    const reader: PrevFailureReader = {
      async listIssueWorkspaces() {
        return ["/a", "/b"];
      },
      async readMarker(dir, file) {
        if (file !== FAILURE_REASON_FILE) return null;
        return dir === "/b" ? "newest\n" : "oldest\n";
      },
      async modifiedAt(dir) {
        return dir === "/b" ? 200 : 100;
      },
    };
    expect(await readPrevFailureContext("/root", 3, reader)).toEqual({ reason: "newest" });
  });

  it("rejects a malformed identity", async () => {
    await expect(readPrevFailureContext("", 1)).rejects.toThrow(/root is required/);
    await expect(readPrevFailureContext("/root", 0)).rejects.toThrow(/invalid issue/);
  });
});

describe("formatPrevFailureContext", () => {
  it("puts the envelope reference first and the free-text reason last", () => {
    expect(
      formatPrevFailureContext({ reason: "blocked: gate red", envelopeRef: "https://github.com/o/r/issues/9" }),
    ).toBe(["prev-envelope: https://github.com/o/r/issues/9", "prev-failure-reason:", "blocked: gate red"].join("\n"));
  });

  it("omits the envelope line when no reference was recorded", () => {
    expect(formatPrevFailureContext({ reason: "crashed" })).toBe("prev-failure-reason:\ncrashed");
  });
});
