import { release } from "node:os";

export type RedskilledHostEnvironment = "native" | "wsl";

/** The kernel-side topology that owns the daemon and its event lane. */
export interface RedskilledHostTopology {
  readonly platform: NodeJS.Platform;
  readonly environment: RedskilledHostEnvironment;
}

export type RedskilledHostEventTopology =
  | "same-side"
  | "wsl-daemon/native-windows-consumer"
  | "native-windows-daemon/wsl-consumer";

export interface RedskilledHostEventTopologyVerdict {
  readonly observable: boolean;
  readonly topology: RedskilledHostEventTopology;
  readonly detail: string;
}

/** Detect WSL from uname's kernel release, never from unsettable process state. */
export function detectRedskilledHostTopology(input: {
  readonly platform?: NodeJS.Platform;
  readonly release?: string;
} = {}): RedskilledHostTopology {
  const platform = input.platform ?? process.platform;
  const kernelRelease = input.release ?? release();
  return {
    platform,
    environment: platform === "linux" && /(?:microsoft|wsl)/i.test(kernelRelease) ? "wsl" : "native",
  };
}

/** Validate topology read from a daemon document before trusting its boundary. */
export function isRedskilledHostTopology(value: unknown): value is RedskilledHostTopology {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const topology = value as Record<string, unknown>;
  return typeof topology.platform === "string" &&
    (topology.environment === "native" || topology.environment === "wsl") &&
    (topology.environment !== "wsl" || topology.platform === "linux");
}

/** Read an explicitly reported topology from a daemon document. */
export function readRedskilledHostTopology(document: unknown): RedskilledHostTopology | null {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  const topology = (document as Record<string, unknown>).topology;
  return isRedskilledHostTopology(topology) ? topology : null;
}

/** State whether a file-backed event lane can notify this consumer. */
export function evaluateRedskilledHostEventTopology(
  daemon: RedskilledHostTopology,
  consumer: RedskilledHostTopology,
): RedskilledHostEventTopologyVerdict {
  const daemonWsl = daemon.environment === "wsl";
  const consumerWsl = consumer.environment === "wsl";
  const daemonWindows = daemon.platform === "win32" && !daemonWsl;
  const consumerWindows = consumer.platform === "win32" && !consumerWsl;
  if (daemonWsl && consumerWindows) {
    return {
      observable: false,
      topology: "wsl-daemon/native-windows-consumer",
      detail: "WSL daemon -> native Windows consumer: file-change notification does not cross the WSL boundary",
    };
  }
  if (daemonWindows && consumerWsl) {
    return {
      observable: false,
      topology: "native-windows-daemon/wsl-consumer",
      detail: "native Windows daemon -> WSL consumer: file-change notification does not cross the WSL boundary",
    };
  }
  return {
    observable: true,
    topology: "same-side",
    detail: `${describeHostSide(daemon)} daemon -> ${describeHostSide(consumer)} consumer is observable`,
  };
}

function describeHostSide(topology: RedskilledHostTopology): string {
  if (topology.environment === "wsl") return "WSL";
  if (topology.platform === "win32") return "native Windows";
  return `native ${topology.platform}`;
}
