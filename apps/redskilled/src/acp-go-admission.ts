// acp-go-admission — how the `go_dispatch` extension method gets a Worker.
//
// The method answers with a Worker id, so something must admit one. A `/go`
// dispatch arrives as a bare request rather than inside a prompt turn, so it
// has no session to attach to and mints its own: the Worker's narration has to
// reach the client SOMEWHERE, and a Worker admitted against no session is one
// nobody can watch, cancel, or read a permission prompt from.
//
// The dialect-shaped parts — how an update is framed, how a permission request
// is projected — stay with the caller, because that is the one thing v1 and v2
// genuinely differ about here.
import { randomUUID } from "node:crypto";
import type {
  AgentConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import type { PublicSession } from "./acp-control-plane.js";
import { createAcpSessionJournal as createAcpDispatchJournal } from "./acp-dispatch-intent.js";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import type { GoWorkerAdmission } from "./acp-go-dispatch.js";
import { admitNativeAcpWorker } from "./acp-native-worker.js";
import type { ActiveWorkflowWorker } from "./acp-worker-lifecycle.js";
import type { AcpSessionJournal } from "./acp-session-journal.js";
import type { RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";

export interface GoWorkerAdmissionDeps {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly sessionJournal: AcpSessionJournal;
  /** This connection's public sessions; a dispatch mints one of its own. */
  readonly sessions: Map<string, PublicSession>;
  readonly active: Map<string, ActiveWorkflowWorker>;
  /** The Project that bound this connection. Throws when none has. */
  readonly project: () => AcpProjectWorkspace;
  /** Frame this Worker's updates in the dialect the caller is speaking. */
  readonly forward: (sessionId: string) => AgentConnection["client"]["notify"];
  /** Ask the caller for a permission decision, in its own dialect. */
  readonly permission: (
    sessionId: string,
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

/**
 * Admit one Worker for a minted Ticket, on a session minted with it.
 *
 * The session is registered BEFORE admission so that a Worker which starts
 * narrating immediately has somewhere to narrate to, and the Worker is tracked
 * in `active` after it so that connection teardown reaps it like any other.
 */
export function createGoWorkerAdmission(deps: GoWorkerAdmissionDeps) {
  return async (dispatch: AcpTargetedDispatchIntent): Promise<GoWorkerAdmission> => {
    const project = deps.project();
    const sessionId = randomUUID();
    const session: PublicSession = {
      request: { cwd: project.workspacePath, mcpServers: [] },
      project,
      dispatchJournal: createAcpDispatchJournal(),
    };
    await deps.sessionJournal.create(sessionId, project);
    deps.sessions.set(sessionId, session);
    let worker: ActiveWorkflowWorker;
    try {
      worker = await admitNativeAcpWorker(
        { paths: deps.paths, startWorker: deps.startWorker },
        deps.sessionJournal,
        session,
        sessionId,
        deps.forward(sessionId),
        (request) => deps.permission(sessionId, request),
        false,
        dispatch,
      );
    } catch (error) {
      deps.sessions.delete(sessionId);
      throw error;
    }
    deps.active.set(sessionId, worker);
    return { worker_id: worker.workerId, session_id: sessionId };
  };
}
