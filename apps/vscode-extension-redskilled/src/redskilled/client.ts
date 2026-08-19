/**
 * client — the extension's READ half of the `redskilled` wire.
 *
 * **Read-only, and deliberately.** It sends `ping`, `host-state`,
 * `statusline-payload` and `statusline-dashboard`, and it never sends
 * `worker-start`, `worker-command`,
 * `project-register` or `shutdown`. ADR 0130 rule 9 makes reach asymmetric — a
 * session reads the whole host and writes only its own project — and an editor
 * panel has no business on the writing half: a view that could stop another
 * project's Worker would be a control surface wearing a monitor's name.
 *
 * **It never spawns the daemon either.** `redskilled provision` and the client
 * inside the dev bundle own auto-spawn; a tree view restoring with the window
 * must not be what starts a machine-wide singleton. An absent daemon is reported
 * as absent, which is the honest answer.
 *
 * The framing and the encoding come from `@reddb-io/shared/resident-core.js`, so
 * the extension inherits the whole TOON/JSON migration order (`resident-wire`
 * rules 1–3) rather than restating it: requests go out as TOON, responses are
 * decoded in whichever dialect they arrive in, and a peer that proves it only
 * reads JSON is remembered. That is why nothing here calls `JSON.parse` on a
 * frame — the daemon's wire has been TOONL since #2947/#2948.
 *
 * TODO(#2997): once `apps/herdr-plugin-redskilled/` lands, lift this client and
 * `event-lane.ts` into one shared read module instead of a second local copy.
 */
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import type {
  RedskilledHostState,
  RedskilledPong,
  RedskilledRequest,
  RedskilledResponse,
  RedskilledStatuslinePayload,
} from "@reddb-io/redskilled/protocol";
import { isRedskilledStatuslinePayload } from "@reddb-io/redskilled/protocol";
import type { RedskilledStatuslineExtrasRequest } from "@reddb-io/redskilled/statusline-payload";
import { isRedskilledHostState } from "@reddb-io/redskilled/host-state";

/** Raised when nothing answered — never confused with "the host is idle". */
export class RedskilledUnreachableError extends Error {
  readonly socketPath: string;

  constructor(message: string, socketPath: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RedskilledUnreachableError";
    this.socketPath = socketPath;
  }
}

/** Raised when the daemon answered and refused. The sentence is the daemon's. */
export class RedskilledRefusedError extends Error {
  readonly op: string;

  constructor(message: string, op: string) {
    super(message);
    this.name = "RedskilledRefusedError";
    this.op = op;
  }
}

export interface RedskilledReadClient {
  readonly socketPath: string;
  ping(): Promise<RedskilledPong>;
  hostState(): Promise<RedskilledHostState>;
  /**
   * The whole machine in one read, and the only read a frame makes.
   *
   * **The table is drawn from THIS document, in this process, by the shared
   * render module** (ADR 0132 decisions 1 and 9). It used to be a second socket
   * call to `statusline-dashboard`, which bought a round trip per frame to
   * receive text this extension could compute itself from bytes it already held.
   * What keeps the panel from drifting away from a terminal pane is no longer a
   * shared string but shared code: both call `renderRedskilledDashboard`.
   *
   * `extras` names the count-scaling blocks this frame needs — the panel wants
   * the display records, and a health check wants none of them.
   */
  statuslinePayload(
    sessionProject?: string,
    extras?: RedskilledStatuslineExtrasRequest,
  ): Promise<RedskilledStatuslinePayload>;
}

export interface CreateReadClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

let sequence = 0;

function nextRequestId(op: string): string {
  sequence += 1;
  return `vscode-extension-red-skills:${op}:${process.pid}:${sequence}`;
}

/** The read surface, bound to one socket. */
export function createRedskilledReadClient(options: CreateReadClientOptions): RedskilledReadClient {
  const { socketPath, timeoutMs = 2_000 } = options;

  async function call(request: RedskilledRequest): Promise<unknown> {
    let response: RedskilledResponse;
    try {
      response = await sendLineRequest<RedskilledRequest, RedskilledResponse>(
        { socketPath, timeoutMs },
        request,
        "redskilled daemon",
      );
    } catch (cause) {
      throw new RedskilledUnreachableError(
        `redskilled is not reachable at ${socketPath}: ${describe(cause)}`,
        socketPath,
        { cause },
      );
    }
    if (response.ok === true) return response.value;
    throw new RedskilledRefusedError(
      response.error || "the daemon refused without a reason",
      request.op,
    );
  }

  return {
    socketPath,
    async ping() {
      const value = await call({ id: nextRequestId("ping"), op: "ping" });
      return value as RedskilledPong;
    },
    async hostState() {
      const value = await call({ id: nextRequestId("host-state"), op: "host-state" });
      // Shape-checked rather than trusted: one daemon serves checkouts pinned to
      // different bundle versions, so "an answer arrived" and "the answer is the
      // document this view renders" are separate facts (ADR 0130 rule 3).
      if (!isRedskilledHostState(value)) {
        throw new RedskilledRefusedError("the daemon answered host-state with a shape this view cannot read", "host-state");
      }
      return value;
    },
    async statuslinePayload(sessionProject?: string, extras?: RedskilledStatuslineExtrasRequest) {
      const value = await call({
        id: nextRequestId("statusline-payload"),
        op: "statusline-payload",
        ...(sessionProject ? { session_project: sessionProject } : {}),
        ...(extras ? { extras } : {}),
      });
      if (!isRedskilledStatuslinePayload(value)) {
        throw new RedskilledRefusedError(
          "the daemon answered statusline-payload with a shape this view cannot read",
          "statusline-payload",
        );
      }
      return value;
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
