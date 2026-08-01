/**
 * client — one TOON-framed request over the daemon's unix socket.
 *
 * This plugin is a READ client and nothing else. It sends `ping`, `host-state`,
 * `statusline-payload`, `statusline-string` and `statusline-dashboard`, and it
 * never sends `worker-start`,
 * `worker-command`, `project-register` or `shutdown`. ADR 0130 rule 9 makes reach
 * asymmetric — read the host, write the project — and a dashboard has no business
 * on the writing half: a viewer that could stop another project's Worker would be
 * a control surface wearing a monitor's name.
 *
 * **It never spawns the daemon either.** `redskilled provision` and the client
 * inside red-skills own auto-spawn; a herdr pane opening on session restore must
 * not be what starts a machine-wide singleton. An absent daemon is reported as
 * absent, which is the honest answer and the one `/red-doctor` gives too.
 */
import { createConnection } from "node:net";

import { decodeFrame, encodeFrame, takeFrame } from "./wire.mjs";

/** Raised when nothing answered — never confused with "the host is idle". */
export class RedskilledUnreachableError extends Error {
  constructor(message, { socketPath, cause } = {}) {
    super(message, { cause });
    this.name = "RedskilledUnreachableError";
    this.socketPath = socketPath;
  }
}

/** Raised when the daemon answered and refused. Its sentence is the daemon's. */
export class RedskilledRequestError extends Error {
  constructor(message, { op } = {}) {
    super(message);
    this.name = "RedskilledRequestError";
    this.op = op;
  }
}

let sequence = 0;

function nextRequestId(op) {
  sequence += 1;
  return `herdr-red-skills:${op}:${process.pid}:${sequence}`;
}

/**
 * Send one request and resolve the one response line.
 *
 * Every failure mode collapses into `RedskilledUnreachableError` carrying its
 * cause, so a caller can tell "nothing answered" from "the daemon said no"
 * without matching on errno strings.
 */
export function sendRedskilledRequest({ socketPath, timeoutMs = 2_000 }, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";

    const timer = setTimeout(() => {
      finish(() =>
        reject(new RedskilledUnreachableError(`redskilled did not answer within ${timeoutMs}ms`, { socketPath })),
      );
      socket.destroy();
    }, timeoutMs);

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    socket.on("connect", () => socket.write(encodeFrame(request)));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const framed = takeFrame(buffer);
      if (!framed) return;
      buffer = framed.rest;
      finish(() => {
        try {
          resolve(decodeFrame(framed.frame));
        } catch (cause) {
          reject(
            new RedskilledUnreachableError(
              "redskilled answered with a frame this plugin cannot read; the daemon predates the TOON wire (#2947)",
              { socketPath, cause },
            ),
          );
        }
      });
      socket.end();
    });
    socket.on("error", (cause) =>
      finish(() =>
        reject(new RedskilledUnreachableError(`redskilled is not reachable at ${socketPath}: ${cause.message}`, { socketPath, cause })),
      ),
    );
    socket.on("close", () => {
      if (!settled) {
        finish(() => reject(new RedskilledUnreachableError("redskilled closed without answering", { socketPath })));
      }
    });
  });
}

/** The read surface, bound to one socket. */
export function createRedskilledClient({ socketPath, timeoutMs = 2_000 }) {
  async function call(op, extra = {}) {
    const response = await sendRedskilledRequest({ socketPath, timeoutMs }, {
      id: nextRequestId(op),
      op,
      ...extra,
    });
    if (response && response.ok === true) return response.value;
    const detail = response && typeof response.error === "string" ? response.error : "the daemon refused without a reason";
    throw new RedskilledRequestError(detail, { op });
  }

  return {
    socketPath,
    ping: () => call("ping"),
    hostState: () => call("host-state"),
    statuslinePayload: (sessionProject) =>
      call("statusline-payload", sessionProject ? { session_project: sessionProject } : {}),
    statuslineString: (sessionProject, render) =>
      call("statusline-string", {
        ...(sessionProject ? { session_project: sessionProject } : {}),
        ...(render ? { render } : {}),
      }),
    /**
     * The dashboard: the same read again, already laid out as a table.
     *
     * This plugin PRINTS what comes back and computes no cell of it. The daemon
     * is the only process holding the Worker set across projects, so a pane that
     * did its own Worker math would be the second authority ADR 0130 rule 10
     * keeps the statusline pair pure to avoid — and two dashboards would lie in
     * two different ways about the same instant.
     */
    statuslineDashboard: (sessionProject, dashboard) =>
      call("statusline-dashboard", {
        ...(sessionProject ? { session_project: sessionProject } : {}),
        ...(dashboard ? { dashboard } : {}),
      }),
  };
}

/**
 * One read of everything a surface needs, as a total answer.
 *
 * A failed read comes back as `{ reachable: false, error }` rather than throwing,
 * because a dashboard that unmounted on a daemon restart would lose the very
 * frame an operator was watching for. The absence is rendered, not raised.
 */
export async function readRedskilledSnapshot(client, { sessionProject } = {}) {
  try {
    const [payload, hostState] = await Promise.all([
      client.statuslinePayload(sessionProject),
      client.hostState().catch(() => null),
    ]);
    return { reachable: true, payload, hostState, error: null, read_at: new Date().toISOString() };
  } catch (error) {
    return {
      reachable: false,
      payload: null,
      hostState: null,
      error: { name: error.name, message: error.message },
      read_at: new Date().toISOString(),
    };
  }
}
