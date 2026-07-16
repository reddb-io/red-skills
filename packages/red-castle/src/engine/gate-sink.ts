export interface GateFinding {
  kind: string;
  description: string;
  patch?: string;
}

export type GateSinkOutcome = "approved" | "skipped" | "parked";

export interface GateSink {
  intentFinding: (finding: GateFinding) => Promise<GateSinkOutcome>;
  sensitivePath: (hit: SensitivePathHit) => Promise<GateSinkOutcome>;
}

export interface SensitivePathHit {
  path: string;
  reason: string;
}

export function makeHeadlessGateSink(input: {
  parkIntent: (finding: GateFinding) => Promise<void>;
  parkSensitivePath: (hit: SensitivePathHit) => Promise<void>;
}): GateSink {
  return {
    async intentFinding(finding) {
      await input.parkIntent(finding);
      return "parked";
    },
    async sensitivePath(hit) {
      await input.parkSensitivePath(hit);
      return "parked";
    },
  };
}

export function makeInteractiveGateSink(input: {
  askIntent: (finding: GateFinding) => Promise<"approved" | "skipped">;
  askSensitivePath: (hit: SensitivePathHit) => Promise<"approved" | "skipped">;
}): GateSink {
  return {
    intentFinding: input.askIntent,
    sensitivePath: input.askSensitivePath,
  };
}
