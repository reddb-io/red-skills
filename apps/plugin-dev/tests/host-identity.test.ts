import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
  HOST_FINGERPRINT_LENGTH,
  fingerprintHost,
  hostFingerprint,
  hostFingerprintPrefix,
  workerIdentity,
} from "../src/core/host-identity.js";
import { parseClaimRecords, renderClaimComment } from "../src/core/claim.js";
import { splitClaimIdentity } from "../src/core/process-safety.js";

describe("fingerprintHost", () => {
  it("is the md5 of the host truncated to the fingerprint length", () => {
    const expected = createHash("md5")
      .update("cyber-XPS-13-9300")
      .digest("hex")
      .slice(0, HOST_FINGERPRINT_LENGTH);
    expect(fingerprintHost("cyber-XPS-13-9300")).toBe(expected);
    expect(fingerprintHost("cyber-XPS-13-9300")).toHaveLength(12);
    expect(fingerprintHost("cyber-XPS-13-9300")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic per host, so a worker still recognizes its own marker", () => {
    expect(fingerprintHost("mbp.local")).toBe(fingerprintHost("mbp.local"));
  });

  it("distinguishes different hosts", () => {
    expect(fingerprintHost("mbp.local")).not.toBe(fingerprintHost("mbp2.local"));
  });

  it("never leaks the host name it hashed", () => {
    expect(fingerprintHost("cyber-XPS-13-9300")).not.toContain("cyber");
  });
});

describe("hostFingerprint", () => {
  it("resolves this host's fingerprint through the one shared helper", () => {
    expect(hostFingerprint()).toBe(fingerprintHost(hostname()));
    expect(hostFingerprintPrefix()).toBe(`${hostFingerprint()}:`);
  });
});

describe("workerIdentity", () => {
  it("renders as <hashed-host>:<workerId> with the worker id unchanged", () => {
    expect(workerIdentity("w2VPT")).toBe(`${hostFingerprint()}:w2VPT`);
    expect(workerIdentity("w2VPT")).toMatch(/^[0-9a-f]{12}:w2VPT$/);
    expect(splitClaimIdentity(workerIdentity("w2VPT"))).toEqual({
      host: hostFingerprint(),
      worker: "w2VPT",
    });
  });

  it("keeps the raw host name out of the emitted claim and concede comments", () => {
    const self = { worker: workerIdentity("w2VPT"), runner: "claude" };
    const claim = renderClaimComment(self, "claim");
    const concede = renderClaimComment(self, "concede");
    for (const body of [claim, concede]) {
      expect(body).not.toContain(hostname());
      expect(body).toContain(`${hostFingerprint()}:w2VPT`);
    }
  });
});

describe("legacy raw-hostname markers", () => {
  it("still parse without crashing (migration is out of scope)", () => {
    const records = parseClaimRecords([
      { id: 1, body: "<!-- afk:claim v1 worker=cyber-XPS-13-9300:w46N2 kind=claim runner=claude -->" },
    ]);
    expect(records).toEqual([
      { commentId: 1, worker: "cyber-XPS-13-9300:w46N2", kind: "claim", runner: "claude", createdAt: undefined },
    ]);
  });
});
