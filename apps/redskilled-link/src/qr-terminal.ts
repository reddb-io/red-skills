import { encode } from "uqr";

const ENTER_TERMINAL_SURFACE = "\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l";
const LEAVE_TERMINAL_SURFACE = "\u001b[0m\u001b[?25h\u001b[?1049l";
const HANDLED_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
const SIGNAL_EXIT_CODES: Record<(typeof HANDLED_SIGNALS)[number], number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

interface QrTerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  isPaused(): boolean;
  setRawMode(enabled: boolean): void;
  resume(): void;
  pause(): void;
  onData(listener: (data: Buffer) => void): void;
  offData(listener: (data: Buffer) => void): void;
}

interface QrTerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(value: string): void;
}

interface QrSignalSource {
  on(signal: (typeof HANDLED_SIGNALS)[number], listener: () => void): void;
  off(signal: (typeof HANDLED_SIGNALS)[number], listener: () => void): void;
  setExitCode(code: number): void;
}

export interface QrTerminalDependencies {
  readonly input: QrTerminalInput;
  readonly output: QrTerminalOutput;
  readonly signals: QrSignalSource;
  readonly now: () => number;
}

export function invitationRemainingMs(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Date.parse(expiresAt) - now);
}

export function renderInvitationQr(
  invitationUri: string,
  terminal: { readonly columns?: number; readonly rows?: number } = {},
): string {
  const qr = encode(invitationUri, { border: 0, ecc: "M" });
  const qrLines = renderMatrix(qr.data);
  const lines = [
    "Pair Redskilled Mobile",
    "",
    ...qrLines,
    "",
    "Scan this one-use invitation. Press q or Esc to close.",
  ];
  const requiredColumns = Math.max(qr.size + 8, ...lines.map(visibleLength));
  if ((terminal.columns ?? Infinity) < requiredColumns || (terminal.rows ?? Infinity) < lines.length) {
    throw new Error(`terminal is too small for the pairing QR (${requiredColumns}x${lines.length} required)`);
  }
  return lines.join("\n");
}

export async function showInvitationQr(
  invitationUri: string,
  expiresAt: string,
  dependencies = systemTerminalDependencies(),
): Promise<boolean> {
  const { input, output, signals } = dependencies;
  if (input.isTTY !== true || output.isTTY !== true) return false;

  const frame = renderInvitationQr(invitationUri, output);
  const wasPaused = input.isPaused();
  const wasRaw = input.isRaw === true;
  let timer: NodeJS.Timeout | undefined;
  let receivedSignal: (typeof HANDLED_SIGNALS)[number] | undefined;
  let enteredSurface = false;
  let finish: () => void = () => undefined;
  const onData = (data: Buffer) => {
    const value = data.toString("utf8").toLowerCase();
    if (value.includes("q") || value.includes("\u001b") || value.includes("\u0003")) finish();
  };
  const signalListeners = new Map<(typeof HANDLED_SIGNALS)[number], () => void>();
  const completion = new Promise<void>((resolve) => { finish = resolve; });

  input.onData(onData);
  for (const signal of HANDLED_SIGNALS) {
    const listener = () => {
      receivedSignal = signal;
      finish();
    };
    signalListeners.set(signal, listener);
    signals.on(signal, listener);
  }
  timer = setTimeout(finish, invitationRemainingMs(expiresAt, dependencies.now()));

  try {
    enteredSurface = true;
    output.write(`${ENTER_TERMINAL_SURFACE}${frame}`);
    input.setRawMode(true);
    input.resume();
    await completion;
  } finally {
    if (timer != null) clearTimeout(timer);
    input.offData(onData);
    for (const [signal, listener] of signalListeners) signals.off(signal, listener);
    try {
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    } finally {
      if (enteredSurface) output.write(LEAVE_TERMINAL_SURFACE);
    }
  }

  if (receivedSignal != null) signals.setExitCode(SIGNAL_EXIT_CODES[receivedSignal]);
  return true;
}

function renderMatrix(modules: readonly (readonly boolean[])[]): string[] {
  const margin = 4;
  const size = modules.length + margin * 2;
  const lines: string[] = [];
  const moduleAt = (row: number, column: number) => {
    const qrRow = row - margin;
    const qrColumn = column - margin;
    return qrRow >= 0 && qrColumn >= 0 && qrRow < modules.length && qrColumn < modules.length &&
      modules[qrRow]?.[qrColumn] === true;
  };
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let column = 0; column < size; column += 1) {
      const foreground = moduleAt(row, column) ? 30 : 37;
      const background = moduleAt(row + 1, column) ? 40 : 47;
      line += `\u001b[${foreground};${background}m\u2580`;
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines;
}

function visibleLength(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function systemTerminalDependencies(): QrTerminalDependencies {
  return {
    input: {
      get isTTY() { return process.stdin.isTTY; },
      get isRaw() { return process.stdin.isRaw; },
      isPaused: () => process.stdin.isPaused(),
      setRawMode: (enabled) => { process.stdin.setRawMode(enabled); },
      resume: () => { process.stdin.resume(); },
      pause: () => { process.stdin.pause(); },
      onData: (listener) => { process.stdin.on("data", listener); },
      offData: (listener) => { process.stdin.off("data", listener); },
    },
    output: {
      get isTTY() { return process.stdout.isTTY; },
      get columns() { return process.stdout.columns; },
      get rows() { return process.stdout.rows; },
      write: (value) => { process.stdout.write(value); },
    },
    signals: {
      on: (signal, listener) => { process.on(signal, listener); },
      off: (signal, listener) => { process.off(signal, listener); },
      setExitCode: (code) => { process.exitCode = code; },
    },
    now: Date.now,
  };
}
