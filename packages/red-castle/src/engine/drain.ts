export interface DrainRequest {
  readonly runner: string;
  readonly target: number;
}

export interface DrainRegistrationState {
  readonly runner: string;
  readonly target: number;
}

export interface DrainState {
  readonly daemon_reachable: boolean;
  readonly registration: DrainRegistrationState | null;
  readonly lapsed: boolean;
  readonly workers: number;
}

export type DrainAction =
  | { readonly kind: "reach-daemon" }
  | { readonly kind: "register"; readonly runner: string; readonly target: number };

export interface DrainReport {
  readonly registration: string;
  readonly target: string;
  readonly runner: string;
  readonly workers_born: number | "kept";
}

export interface DrainPlan {
  readonly outcome: "apply";
  readonly actions: readonly DrainAction[];
  readonly report: DrainReport;
  readonly summary: string;
}

function renderDrainReport(report: DrainReport): string {
  return `registration: ${report.registration}; target: ${report.target}; runner: ${report.runner}; workers born: ${report.workers_born}`;
}

/** Plan how `drain` makes the requested project state true. PURE. */
export function planDrain(state: DrainState, request: DrainRequest): DrainPlan {
  if (state.registration !== null) {
    throw new Error("a standing registration is not implemented yet");
  }
  const report: DrainReport = {
    registration: state.lapsed ? "re-created" : "created",
    target: `0→${request.target}`,
    runner: `none→${request.runner}`,
    workers_born: Math.max(0, request.target - state.workers),
  };
  return {
    outcome: "apply",
    actions: [
      ...(state.daemon_reachable ? [] : [{ kind: "reach-daemon" as const }]),
      { kind: "register", runner: request.runner, target: request.target },
    ],
    report,
    summary: renderDrainReport(report),
  };
}
