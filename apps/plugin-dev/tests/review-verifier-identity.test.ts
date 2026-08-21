/**
 * ADR 0154's rule is that no agent lands on its own verdict, and the reviewer
 * resolver it inherits defaults to the IMPLEMENTER when nothing is configured.
 * These tests pin the correction: a verifier is only a verifier when its
 * `<runner>:<model>` differs from the identity that wrote the diff, and a
 * configuration that offers no such identity REFUSES rather than signing twice.
 */
import { describe, expect, it } from "vitest";
import { getConfig, loadConfig } from "../src/core/config.js";
import { resolveAdversarialReviewConfig } from "../src/core/adversarial-review.js";
import {
  REVIEW_VERIFIER_RUNNER_PREFERENCE,
  resolveReviewVerifier,
  reviewImplementerIdentity,
  reviewVerifierRefusal,
} from "../src/core/review-verifier-identity.js";

const IMPLEMENTER = { runner: "claude", model: "claude-opus-5", effort: "high" } as const;

function shippedReviewConfig() {
  const values = loadConfig("/nonexistent/.red/config.yaml", {
    ignoreActivationGate: true,
    warn: () => {},
  });
  return resolveAdversarialReviewConfig((key) => getConfig(values, key));
}

describe("review verifier identity (ADR 0154, #4137)", () => {
  it("spells the implementer identity exactly as a verdict row's verifier_identity", () => {
    expect(reviewImplementerIdentity(IMPLEMENTER)).toBe("claude:claude-opus-5");
  });

  it("moves off the implementer when nothing is configured, so the row is never a self-verdict", () => {
    const verifier = resolveReviewVerifier({
      config: shippedReviewConfig(),
      implementer: IMPLEMENTER,
      taskClass: "complex",
    });
    expect(verifier).not.toBeNull();
    expect(verifier!.identity).not.toBe(reviewImplementerIdentity(IMPLEMENTER));
    expect(verifier!.runner).not.toBe(IMPLEMENTER.runner);
    // The first preference that is not the implementer's own runner.
    expect(verifier!.runner).toBe(REVIEW_VERIFIER_RUNNER_PREFERENCE[0]);
  });

  it("honours a configured reviewer runner that is already a different identity", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    review:\n      runner: opencode\n",
    });
    const verifier = resolveReviewVerifier({
      config: resolveAdversarialReviewConfig((key) => getConfig(values, key)),
      implementer: IMPLEMENTER,
      taskClass: "complex",
      resolveTier: () => ({ model: "openrouter/anthropic/claude-opus-5", effort: "high" }),
    });
    expect(verifier).toMatchObject({
      runner: "opencode",
      identity: "opencode:openrouter/anthropic/claude-opus-5",
    });
  });

  it("refuses when the preference list offers no identity other than the implementer's", () => {
    const input = {
      config: shippedReviewConfig(),
      implementer: IMPLEMENTER,
      taskClass: "complex" as const,
      preference: [] as const,
    };
    expect(resolveReviewVerifier(input)).toBeNull();
    expect(reviewVerifierRefusal(input)).toContain("claude:claude-opus-5");
    expect(reviewVerifierRefusal(input)).toContain("would sign the diff it wrote");
  });

  it("reports no refusal for the shipped configuration", () => {
    expect(
      reviewVerifierRefusal({
        config: shippedReviewConfig(),
        implementer: IMPLEMENTER,
        taskClass: "complex",
      }),
    ).toBeNull();
  });
});
