export interface GateFinding {
  kind: string;
  description: string;
  patch?: string;
}

export type GateSinkOutcome = "approved" | "skipped" | "parked";

export interface GateSink {
  intentFinding: (finding: GateFinding) => Promise<GateSinkOutcome>;
}

export function makeHeadlessGateSink(input: {
  parkIntent: (finding: GateFinding) => Promise<void>;
}): GateSink {
  return {
    async intentFinding(finding) {
      await input.parkIntent(finding);
      return "parked";
    },
  };
}

export function makeInteractiveGateSink(input: {
  askIntent: (finding: GateFinding) => Promise<"approved" | "skipped">;
}): GateSink {
  return {
    intentFinding: input.askIntent,
  };
}
