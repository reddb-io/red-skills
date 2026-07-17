import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { encode, type JsonObject } from "@reddb-io/toon";
import { type RspLossLevel, type RspMintMeta } from "./elision-store.js";
import { recoveryInstruction, type GitRenderResult, type RecordedGitContract } from "./git-wrapper.js";
import { classifyWrappedFailure, renderStructuredError } from "./structured-error.js";

export interface CatRenderOptions {
  level: RspLossLevel;
  store?: RspMintStore;
  heavyByteThreshold?: number;
}

interface RspMintStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

interface ParsedCatCommand {
  file: string;
  mode: "full" | "head" | "tail";
  limit?: number;
  inlineFull?: boolean;
}

type FileSymbol = JsonObject & {
  kind: "class" | "function" | "interface" | "method" | "type";
  name: string;
  line: number;
  signature: string;
};

const DEFAULT_CAT_HEAVY_BYTE_THRESHOLD = 8 * 1024;
const DEFAULT_SLICE_LINES = 10;
const BRIEF_CONTEXT_LINES = 8;
const TERSE_CONTEXT_LINES = 2;
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
]);

export async function runCatWrapper(argv: readonly string[], options: CatRenderOptions): Promise<GitRenderResult> {
  const parsed = parseCatCommand(argv);
  let bytes: Buffer;
  try {
    bytes = await readFile(parsed.file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = classifyWrappedFailure(argv.join(" "), "", message);
    return {
      stdout: renderStructuredError({ ...error, help: `ls ${parsed.file}` }),
      stderr: Buffer.from(`${message}\n`),
      status: 1,
      signal: null,
    };
  }
  if (isBinary(bytes)) {
    return {
      stdout: bytes,
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
      rawOutput: bytes,
    };
  }
  return await renderCatBytes(argv, parsed, bytes, options);
}

export async function renderCatContract(
  command: readonly string[],
  contract: RecordedGitContract,
  options: CatRenderOptions,
): Promise<GitRenderResult> {
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    const error = classifyWrappedFailure(command.join(" "), contract.stdout, contract.stderr);
    return {
      stdout: renderStructuredError(error),
      stderr: Buffer.from(contract.stderr),
      status: error.exitCode ?? 1,
      signal: contract.signal,
    };
  }
  const parsed = parseCatCommand(command);
  const bytes = Buffer.from(contract.stdout, "utf8");
  if (isBinary(bytes)) {
    return {
      stdout: bytes,
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
      rawOutput: bytes,
    };
  }
  const result = await renderCatBytes(command, parsed, bytes, options);
  return { ...result, stderr: Buffer.from(contract.stderr), status: contract.status, signal: contract.signal };
}

export function parseCatCommand(argv: readonly string[]): ParsedCatCommand {
  if (argv[0] !== "cat") throw new Error("expected rsp cat <file>");
  const args = argv.slice(1);
  let mode: ParsedCatCommand["mode"] = "full";
  let limit: number | undefined;
  let inlineFull = false;
  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--full") {
      inlineFull = true;
      continue;
    }
    if (arg === "--head" || arg === "--tail") {
      mode = arg.slice(2) as "head" | "tail";
      limit = positiveInteger(args[++index], DEFAULT_SLICE_LINES);
      continue;
    }
    if (arg.startsWith("--head=") || arg.startsWith("--tail=")) {
      const [flag, value] = arg.split("=", 2) as [string, string];
      mode = flag.slice(2) as "head" | "tail";
      limit = positiveInteger(value, DEFAULT_SLICE_LINES);
      continue;
    }
    files.push(arg);
  }
  if (files.length !== 1) throw new Error("usage: rsp cat [--full] [--head N|--tail N] <file>");
  return { file: files[0]!, mode, ...(limit ? { limit } : {}), ...(inlineFull ? { inlineFull } : {}) };
}

async function renderCatBytes(
  command: readonly string[],
  parsed: ParsedCatCommand,
  bytes: Buffer,
  options: CatRenderOptions,
): Promise<GitRenderResult> {
  const text = bytes.toString("utf8");
  const sliced = applySlice(text, parsed);
  if (parsed.inlineFull) {
    return {
      stdout: Buffer.from(sliced.text),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
      rawOutput: bytes,
    };
  }
  const shouldElide = options.level !== "lossless" ||
    bytes.length > positiveNumber(options.heavyByteThreshold, DEFAULT_CAT_HEAVY_BYTE_THRESHOLD) ||
    sliced.truncated;
  if (!isCodeFile(parsed.file) && !shouldElide) {
    return {
      stdout: Buffer.from(sliced.text),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
      rawOutput: bytes,
    };
  }

  const payload = isCodeFile(parsed.file)
    ? renderCodePayload(command, parsed.file, bytes, text, options.level, sliced)
    : renderTextPayload(command, parsed.file, bytes, text, sliced);
  const rendered = `${encode(payload as unknown as JsonObject)}\n`;
  if (!shouldElide && Buffer.byteLength(rendered) <= positiveNumber(options.heavyByteThreshold, DEFAULT_CAT_HEAVY_BYTE_THRESHOLD)) {
    return {
      stdout: Buffer.from(rendered),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
      payload,
      rawOutput: bytes,
    };
  }

  const handle = await options.store?.mint(bytes, {
    command: command.join(" "),
    loss: { level: options.level === "lossless" ? "terse" : options.level, bytes_elided: bytes.length },
  });
  if (!handle) throw new Error("rsp cat elision requires an elision store");
  const marker = `… elided file bytes (+${bytes.length}) — ${recoveryInstruction(handle)}\n`;
  return {
    stdout: Buffer.from(`${rendered}${marker}`),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
    payload,
    mintedHandle: handle,
    bytesElided: bytes.length,
    rawOutput: bytes,
  };
}

function renderCodePayload(
  command: readonly string[],
  file: string,
  bytes: Buffer,
  text: string,
  level: RspLossLevel,
  sliced: { text: string; truncated: boolean },
): JsonObject {
  const lines = contentLines(text);
  const contextLines = level === "terse" ? TERSE_CONTEXT_LINES : BRIEF_CONTEXT_LINES;
  const sliceLines = contentLines(sliced.text);
  const head = sliceLines.slice(0, contextLines);
  const tail = sliceLines.slice(Math.max(head.length, sliceLines.length - contextLines));
  return {
    command: command.join(" "),
    file,
    kind: "code",
    outline_source: "regex",
    bytes: bytes.length,
    lines: lines.length,
    symbols: extractSymbols(lines),
    content: {
      head,
      tail,
      truncated: sliced.truncated || head.length + tail.length < lines.length,
    },
  };
}

function renderTextPayload(
  command: readonly string[],
  file: string,
  bytes: Buffer,
  text: string,
  sliced: { text: string; truncated: boolean },
): JsonObject {
  return {
    command: command.join(" "),
    file,
    kind: "text",
    bytes: bytes.length,
    lines: contentLines(text).length,
    content: contentLines(sliced.text),
    truncated: sliced.truncated,
  };
}

function applySlice(text: string, parsed: ParsedCatCommand): { text: string; truncated: boolean } {
  if (parsed.mode === "full") return { text, truncated: false };
  const lines = text.split("\n");
  const hasFinalNewline = lines.at(-1) === "";
  const body = hasFinalNewline ? lines.slice(0, -1) : lines;
  const limit = parsed.limit ?? DEFAULT_SLICE_LINES;
  const selected = parsed.mode === "head" ? body.slice(0, limit) : body.slice(Math.max(0, body.length - limit));
  const rendered = `${selected.join("\n")}${hasFinalNewline && selected.length > 0 ? "\n" : ""}`;
  return { text: rendered, truncated: selected.length < body.length };
}

function extractSymbols(lines: readonly string[]): FileSymbol[] {
  const symbols: FileSymbol[] = [];
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const line = raw.trim();
    const declaration = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (declaration) {
      symbols.push({
        kind: declaration[1] as "class" | "interface" | "type",
        name: declaration[2]!,
        line: index + 1,
        signature: line,
      });
      continue;
    }
    const fn = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?/.exec(line);
    if (fn) {
      symbols.push({ kind: "function", name: fn[1]!, line: index + 1, signature: line });
      continue;
    }
    const method = /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/.exec(line);
    if (method && !isControlKeyword(method[1]!)) {
      symbols.push({ kind: "method", name: method[1]!, line: index + 1, signature: line });
    }
  }
  return symbols;
}

function contentLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0) || !isUtf8(bytes);
}

function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isControlKeyword(value: string): boolean {
  return ["for", "if", "switch", "while"].includes(value);
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
