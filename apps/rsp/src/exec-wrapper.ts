import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { scoreStructuralOutliers, type PreservedOutlierLine } from "./anomaly-scorer.js";
import { type RspMintMeta, type RspLossLevel } from "./elision-store.js";
import { recoveryInstruction, type GitRenderResult, type RecordedGitContract } from "./git-wrapper.js";
import { normalizeOutput, renderGenericJsonLane } from "./normalize.js";
import { classifyWrappedFailure, renderStructuredError } from "./structured-error.js";

export interface ExecRenderOptions {
  level: RspLossLevel;
  store?: RspMintStore;
  heavyByteThreshold?: number;
  anomalyScorer?: (text: string, options: { headBytes: number; tailStart: number }) => PreservedOutlierLine[];
}

interface RspMintStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

const DEFAULT_EXEC_HEAVY_BYTE_THRESHOLD = 8 * 1024;
const BRIEF_INLINE_BYTES = 2 * 1024;
const TERSE_INLINE_BYTES = 1024;

export async function runExecWrapper(argv: readonly string[], options: ExecRenderOptions): Promise<GitRenderResult> {
  const commandLine = parseExecCommandLine(argv);
  const contract = await collectShellContract(commandLine);
  return await renderExecContract(commandLine, contract, options);
}

export async function renderExecContract(
  commandLine: string,
  contract: RecordedGitContract,
  options: ExecRenderOptions,
): Promise<GitRenderResult> {
  const rawStdout = Buffer.from(contract.stdout, "binary");
  const stderr = Buffer.from(contract.stderr, "binary");
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    const error = classifyWrappedFailure(commandLine, contract.stdout, contract.stderr);
    return {
      stdout: renderStructuredError(error),
      stderr,
      status: error.exitCode ?? 1,
      signal: contract.signal,
      rawOutput: rawStdout,
    };
  }
  if (rawStdout.length === 0) {
    return {
      stdout: rawStdout,
      stderr,
      status: contract.status,
      signal: contract.signal,
      rawOutput: rawStdout,
    };
  }

  const normalized = renderNormalizedStdout(rawStdout);
  if (normalized.kind === "text") {
    const jsonLane = await renderGenericJsonLane(normalized.text, {
      level: options.level,
      command: commandLine,
      store: options.store ? {
        mint: async (...args) => await options.store!.mint(...args) as `el:${string}`,
      } : undefined,
    });
    if (jsonLane.detected) {
      return {
        stdout: Buffer.from(jsonLane.output),
        stderr,
        status: contract.status,
        signal: contract.signal,
        mintedHandle: jsonLane.handle,
        bytesElided: jsonLane.lossy ? rawStdout.length : undefined,
        rawOutput: rawStdout,
      };
    }
  }

  const emitted = normalized.kind === "text" ? Buffer.from(normalized.text) : rawStdout;
  const threshold = positiveNumber(options.heavyByteThreshold, DEFAULT_EXEC_HEAVY_BYTE_THRESHOLD);
  if (emitted.length <= threshold && options.level !== "terse") {
    return {
      stdout: emitted,
      stderr,
      status: contract.status,
      signal: contract.signal,
      rawOutput: rawStdout,
    };
  }

  const bytesElided = rawStdout.length;
  const lossLevel = options.level === "lossless" ? "terse" : options.level;
  const handle = await options.store?.mint(rawStdout, {
    command: commandLine,
    loss: { level: lossLevel, bytes_elided: bytesElided },
  });
  if (!handle) throw new Error("rsp exec output elision requires an elision store");

  const rendered = renderTextSummary(emitted, rawStdout.length, handle, options.level, options.anomalyScorer);
  return {
    stdout: Buffer.from(rendered.text),
    stderr,
    status: contract.status,
    signal: contract.signal,
    mintedHandle: handle,
    bytesElided,
    rawOutput: rawStdout,
    degradation: rendered.degradation,
  };
}

export function parseExecCommandLine(argv: readonly string[]): string {
  if (argv[0] !== "exec") throw new Error("expected rsp exec -- <command line>");
  const separator = argv.indexOf("--");
  const parts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
  const commandLine = parts.length === 1 ? parts[0]! : parts.join(" ");
  if (!commandLine.trim()) throw new Error("usage: rsp exec -- <command line>");
  return commandLine;
}

async function collectShellContract(commandLine: string): Promise<RecordedGitContract> {
  const child = spawn(commandLine, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("binary"),
        stderr: Buffer.concat(stderr).toString("binary"),
        status,
        signal,
      });
    });
  });
}

function renderNormalizedStdout(stdout: Buffer): { kind: "text"; text: string } | { kind: "bytes" } {
  if (!isUtf8(stdout)) return { kind: "bytes" };
  return { kind: "text", text: normalizeOutput(stdout.toString("utf8")) };
}

function renderTextSummary(
  stdout: Buffer,
  rawBytes: number,
  handle: string,
  level: RspLossLevel,
  anomalyScorer = defaultAnomalyScorer,
): { text: string; degradation?: GitRenderResult["degradation"] } {
  const inlineBytes = level === "terse" ? TERSE_INLINE_BYTES : BRIEF_INLINE_BYTES;
  const half = Math.max(1, Math.floor(inlineBytes / 2));
  const head = truncateUtf8(stdout.subarray(0, half));
  const tailStart = Math.max(0, stdout.length - half);
  const tail = truncateUtf8(stdout.subarray(tailStart));
  const lines = countLines(stdout);
  const outliers = preservedOutliers(stdout, half, tailStart, anomalyScorer);
  const parts = [
    "stdout summary",
    `bytes: ${rawBytes}`,
    `lines: ${lines}`,
    "head:",
    head,
  ];
  if (tail && tail !== head) parts.push("tail:", tail);
  if (outliers.kind === "ok" && outliers.lines.length > 0) {
    parts.push("preserved outliers:");
    for (const outlier of outliers.lines) {
      parts.push(`[outlier line ${outlier.lineNumber} score ${outlier.score.toFixed(2)}] ${outlier.text}`);
    }
  }
  const markerSuffix = outliers.kind === "ok" && outliers.lines.length > 0
    ? `; preserved_outliers: ${outliers.lines.length}`
    : "";
  parts.push(`… elided stdout (+${rawBytes}${markerSuffix}) — ${recoveryInstruction(handle)}`);
  return {
    text: `${parts.join("\n")}\n`,
    degradation: outliers.kind === "failed"
      ? {
        reason: "exec-anomaly-scorer-failed",
        family: "exec",
        stderrHead: truncateDiagnostic(outliers.error),
      }
      : undefined,
  };
}

function preservedOutliers(
  stdout: Buffer,
  headBytes: number,
  tailStart: number,
  anomalyScorer: (text: string, options: { headBytes: number; tailStart: number }) => PreservedOutlierLine[],
): { kind: "ok"; lines: PreservedOutlierLine[] } | { kind: "failed"; error: unknown } {
  try {
    return { kind: "ok", lines: anomalyScorer(stdout.toString("utf8"), { headBytes, tailStart }) };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function defaultAnomalyScorer(text: string, options: { headBytes: number; tailStart: number }): PreservedOutlierLine[] {
  return scoreStructuralOutliers(text, {
    excludedByteRanges: [
      { start: 0, end: options.headBytes },
      { start: options.tailStart, end: Buffer.byteLength(text, "utf8") },
    ],
  });
}

function truncateDiagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "unknown scorer failure");
  const line = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() || "unknown scorer failure";
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}

function truncateUtf8(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/�$/g, "");
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lines++;
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
