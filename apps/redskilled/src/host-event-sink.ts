/** Operator-scoped programs fired from the daemon's public lifecycle vocabulary. */
import { constants, accessSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { RedskilledAdmissionVerdict } from "./admission.js";
import {
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  type RedskilledPublicHostEventKind,
  type RedskilledWorkerEventKind,
} from "./event-lane.js";
import type { RedskilledHostState, RedskilledWorkerView } from "./host-state.js";
import { workerSpecFromLaunch, type RedskilledLaunchTemplate } from "./launch-template.js";
import { mintHostWorkerId, RedskilledAdmissionError, type RedskilledWorkerSpec } from "./worker-launch.js";

export const REDSKILLED_HOST_EVENT_PROJECT = "redskilled/host-events";

export interface RedskilledHostEventSinks {
  /** Stable daemon-owned directory used verbatim as the sink Worker's cwd. */
  readonly workspacePath: string;
  readonly hooks?: Partial<Record<RedskilledPublicHostEventKind, RedskilledLaunchTemplate>>;
  readonly notifications?: readonly RedskilledPublicHostEventKind[];
  /** Test seam for native notification command selection. */
  readonly platform?: NodeJS.Platform;
  /** Test seam over the PATH probe. Production checks the real filesystem. */
  readonly commandAvailable?: (binary: string) => boolean;
}

export interface RedskilledHostEventSinkRuntime {
  /** Observe a state-changing event after the daemon has updated its Worker set. */
  onEvent(kind: RedskilledWorkerEventKind, worker: RedskilledWorkerView): void;
}

/** Resolve one native notification invocation without shell interpolation. */
export function nativeNotificationTemplate(
  kind: RedskilledPublicHostEventKind,
  state: RedskilledHostState,
  platform: NodeJS.Platform = process.platform,
): RedskilledLaunchTemplate | null {
  const count = state.workers.length;
  const body = kind === "worker-birth"
    ? `Worker born: ${count} active`
    : kind === "worker-death"
      ? `Worker finished: ${count} active`
      : `Worker killed by host budget: ${count} active`;
  if (platform === "linux") return { argv: ["notify-send", "redskilled", body] };
  if (platform === "darwin") {
    return {
      argv: [
        "osascript",
        "-e",
        'display notification (system attribute "REDSKILLED_NOTIFICATION_BODY") with title "redskilled"',
      ],
      env: { REDSKILLED_NOTIFICATION_BODY: body },
    };
  }
  if (platform === "win32") {
    return {
      argv: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; " +
          "$n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle='redskilled'; " +
          "$n.BalloonTipText=$env:REDSKILLED_NOTIFICATION_BODY; $n.Visible=$true; $n.ShowBalloonTip(5000)",
      ],
      env: { REDSKILLED_NOTIFICATION_BODY: body },
    };
  }
  return null;
}

export function createRedskilledHostEventSinkRuntime(options: {
  readonly declaration?: RedskilledHostEventSinks;
  readonly hostState: () => RedskilledHostState;
  readonly liveWorkerIds: () => Iterable<string>;
  readonly admit: (spec: RedskilledWorkerSpec) => RedskilledAdmissionVerdict;
  readonly start: (spec: RedskilledWorkerSpec, admission: RedskilledAdmissionVerdict) => RedskilledWorkerView;
  readonly refuse: (detail: string) => void;
}): RedskilledHostEventSinkRuntime {
  const sinkWorkers = new Set<string>();
  // #4153: a headless host has no notification binary, and firing the sink
  // anyway put an ENOENT death through the Worker birth pipeline every few
  // minutes forever — crash-loop breaker, backoff, re-arm, again. An optional
  // notification degrades: probed ONCE per boot, refused out loud ONCE, and
  // never born again on this runtime.
  let nativeNotificationsUnavailable = false;
  const commandAvailable = options.declaration?.commandAvailable ?? executableOnPath;

  function fire(template: RedskilledLaunchTemplate, state: RedskilledHostState, kind: RedskilledPublicHostEventKind): void {
    const workerId = mintHostWorkerId(options.liveWorkerIds());
    const base = workerSpecFromLaunch(
      template,
      { worker_id: workerId, slot: 0, workspace_path: options.declaration!.workspacePath },
      { project_label: REDSKILLED_HOST_EVENT_PROJECT },
    );
    const spec: RedskilledWorkerSpec = {
      ...base,
      // The hook receives the same versioned document as `host-state`, captured
      // before the hook itself becomes another admitted Worker.
      input: `${JSON.stringify(state)}\n`,
      env: { ...base.env, REDSKILLED_HOST_EVENT: kind },
    };
    sinkWorkers.add(workerId);
    try {
      const admission = options.admit(spec);
      if (!admission.admitted) throw new RedskilledAdmissionError(admission.reason, admission);
      options.start(spec, admission);
    } catch (error) {
      sinkWorkers.delete(workerId);
      options.refuse(
        `operator-scoped ${kind} hook was refused before launch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    onEvent(kind, worker) {
      const isSinkWorker = sinkWorkers.has(worker.worker_id);
      if (isSinkWorker && (kind === "worker-death" || kind === "worker-budget-kill")) {
        sinkWorkers.delete(worker.worker_id);
      }
      if (isSinkWorker || !REDSKILLED_PUBLIC_HOST_EVENT_KINDS.includes(kind as RedskilledPublicHostEventKind)) return;
      const publicKind = kind as RedskilledPublicHostEventKind;
      const hook = options.declaration?.hooks?.[publicKind];
      const notify = options.declaration?.notifications?.includes(publicKind) === true;
      if (hook == null && !notify) return;
      const state = options.hostState();
      if (hook != null) fire(hook, state, publicKind);
      if (notify && !nativeNotificationsUnavailable) {
        const template = nativeNotificationTemplate(publicKind, state, options.declaration?.platform);
        if (template == null) {
          options.refuse(`operator-scoped ${publicKind} notification has no native sink on platform ${process.platform}`);
        } else if (!commandAvailable(template.argv[0]!)) {
          nativeNotificationsUnavailable = true;
          options.refuse(
            `native notifications unavailable on this host: ${template.argv[0]} is not on PATH; ` +
              "disabling the notification sink for this boot",
          );
        } else {
          fire(template, state, publicKind);
        }
      }
    },
  };
}

/** Whether one binary resolves on the daemon's PATH; absolute paths are trusted as-is. */
function executableOnPath(binary: string): boolean {
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      try {
        accessSync(join(directory, `${binary}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Keep walking the PATH; a miss in one directory proves nothing.
      }
    }
  }
  return false;
}
