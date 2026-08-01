// reconcile-ports — the ONE place the host's real implementations are bound to
// reconcile's injected ports.
//
// `core/reconcile.ts` value-imports nothing effectful: landing, the feedback
// gate, the envelope emitter, the remote-branch push/delete pair, and the
// triage-label vocabulary all arrive through `ReconcileDeps`. This module is the
// host adapter that supplies them, so every construction site
// (`commands/run/reconcile.ts`, `commands/requeue.ts`) spreads ONE constant
// instead of re-wiring the same five members. When reconcile crosses into the
// castle engine, this file is the only edge that follows the move.

import { doLanding } from "./landing.js";
import {
  buildValidationRecord,
  formatValidationLine,
  isInfraFeedbackFailure,
  runFeedback,
} from "./feedback.js";
import { gateScopes } from "./validation-scope.js";
import { emitEnvelope } from "./envelope-emit.js";
import { deleteRemote, pushAttempt } from "./remote-branch.js";
import { DEFAULT_TRIAGE_LABELS } from "./triage-labels.js";
import type {
  ReconcileEnvelopeEmitPort,
  ReconcileFeedbackPort,
  ReconcileLandingPort,
  ReconcileRemoteBranchPort,
} from "./reconcile.js";
import type { TriageLabelConfig } from "./triage-labels.js";

/** The five injected members every real (non-test) reconcile shares. */
export interface HostReconcilePorts {
  landing: ReconcileLandingPort;
  feedback: ReconcileFeedbackPort;
  envelopeEmit: ReconcileEnvelopeEmitPort;
  remoteBranch: ReconcileRemoteBranchPort;
  labels: TriageLabelConfig;
}

/** This host's real wiring — spread into every `ReconcileDeps` literal. */
export const HOST_RECONCILE_PORTS: HostReconcilePorts = {
  landing: { doLanding },
  feedback: {
    runFeedback,
    gateScopes,
    isInfraFeedbackFailure,
    buildValidationRecord,
    formatValidationLine,
  },
  envelopeEmit: { emitEnvelope },
  remoteBranch: { pushAttempt, deleteRemote },
  labels: DEFAULT_TRIAGE_LABELS,
};
