import { spawn } from "node:child_process";
import { encode, type JsonObject } from "@reddb-io/toon";
import { RspElisionStore, type RspLossLevel } from "./elision-store.js";
import type { GitRenderResult, RecordedGitContract } from "./git-wrapper.js";

export interface TestRenderOptions {
  level: RspLossLevel;
  store?: RspElisionStore;
}

interface TestFailure extends JsonObject {
  suite: string;
  name: string;
  excerpt: string;
}

interface TestPayload {
  exit_code: number | null;
  summary: string;
  failures?: TestFailure[];
}

interface ParsedTestRun {
  failed: number;
  total: number;
  suites: number;
  durationSeconds: number;
  failures: TestFailureSource[];
}

interface TestFailureSource {
  suite: string;
  name: string;
  excerpt: string;
}

const EXCERPT_LIMIT_BYTES = 320;

export async function runTestWrapper(argv: readonly string[], options: TestRenderOptions): Promise<GitRenderResult> {
  const contract = await collectTestContract(argv);
  return await renderTestContract(argv, contract, options);
}

export async function renderTestContract(
  command: readonly string[],
  contract: RecordedGitContract,
  options: TestRenderOptions,
): Promise<GitRenderResult> {
  const runner = parseTestRunner(command);
  const parsed = runner === "vitest" ? parseVitest(contract.stdout) : parseCargoTest(contract.stdout);
  const status = contract.status;

  if (!parsed || ((status ?? 0) !== 0 && parsed.failed === 0)) {
    return {
      stdout: Buffer.from(contract.stdout),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
    };
  }

  const failures: TestFailure[] = [];
  let mintedHandle: `el:${string}` | undefined;
  let bytesElided = 0;

  for (const failure of parsed.failures) {
    const excerpt = await renderExcerpt(failure.excerpt, command.join(" "), options.store);
    failures.push({ suite: failure.suite, name: failure.name, excerpt: excerpt.text });
    mintedHandle ??= excerpt.handle;
    bytesElided += excerpt.bytesElided;
  }

  const payload: TestPayload = {
    exit_code: status,
    summary: `${parsed.failed}/${parsed.total} failed · ${parsed.suites} suites · ${formatDuration(parsed.durationSeconds)}`,
  };
  if (failures.length > 0) payload.failures = failures;

  return {
    stdout: Buffer.from(encode(payload as unknown as JsonObject)),
    stderr: Buffer.from(contract.stderr),
    status: contract.status,
    signal: contract.signal,
    payload: payload as unknown as JsonObject,
    mintedHandle,
    bytesElided: bytesElided > 0 ? bytesElided : undefined,
    rowsElided: failures.length > 0 ? Math.max(0, parsed.total - failures.length) : undefined,
  };
}

function parseTestRunner(command: readonly string[]): "vitest" | "cargo" {
  if (command[0] === "vitest") return "vitest";
  if (command[0] === "cargo" && command[1] === "test") return "cargo";
  throw new Error(`unsupported test command: ${command.join(" ")}`);
}

function machineArgs(command: readonly string[]): { executable: string; args: string[] } {
  const runner = parseTestRunner(command);
  if (runner === "vitest") {
    const args = command.slice(1);
    const hasReporter = args.some((arg) => arg === "--reporter=json" || arg === "--reporter" || arg.startsWith("--reporter="));
    return { executable: "vitest", args: hasReporter ? args : ["run", "--reporter=json", ...args] };
  }

  const args = command.slice(1);
  const hasMessageFormat = args.some((arg) => arg === "--message-format=json" || arg.startsWith("--message-format="));
  return { executable: "cargo", args: hasMessageFormat ? args : ["test", "--message-format=json", ...args.slice(1)] };
}

async function collectTestContract(command: readonly string[]): Promise<RecordedGitContract> {
  const machine = machineArgs(command);
  const child = spawn(machine.executable, machine.args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal,
      });
    });
  });
}

function parseVitest(stdout: string): ParsedTestRun | null {
  const parsed = parseJson(stdout);
  if (!isRecord(parsed)) return null;

  const testResults = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  const failures: TestFailureSource[] = [];
  let total = numberField(parsed.numTotalTests);
  let failed = numberField(parsed.numFailedTests);
  let durationSeconds = durationFromMs(numberField(parsed.startTime), numberField(parsed.endTime));

  for (const suite of testResults) {
    if (!isRecord(suite)) continue;
    const suiteName = stringField(suite.name) || stringField(suite.file) || "";
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const assertion of assertions) {
      if (!isRecord(assertion)) continue;
      if (assertion.status !== "failed") continue;
      failures.push({
        suite: suiteName,
        name: stringField(assertion.fullName) || stringField(assertion.title) || stringField(assertion.name),
        excerpt: failureMessage(assertion.failureMessages) || stringField(assertion.failureMessage),
      });
    }
  }

  total ||= testResults.reduce((sum, suite) => {
    if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) return sum;
    return sum + suite.assertionResults.length;
  }, 0);
  failed ||= failures.length;
  durationSeconds ||= testResults.reduce((sum, suite) => {
    if (!isRecord(suite)) return sum;
    return sum + numberField(suite.perfStats && isRecord(suite.perfStats) ? suite.perfStats.runtime : suite.duration) / 1000;
  }, 0);

  return {
    failed,
    total,
    suites: testResults.length || 1,
    durationSeconds,
    failures,
  };
}

function parseCargoTest(stdout: string): ParsedTestRun | null {
  const messages = stdout.split("\n").filter(Boolean).map((line) => parseJson(line)).filter(isRecord);
  if (messages.length === 0) return null;

  const failures: TestFailureSource[] = [];
  let total = 0;
  let failed = 0;
  let suites = 0;
  let durationSeconds = 0;
  const compileErrors: string[] = [];

  for (const message of messages) {
    if (message.type === "suite") {
      if (message.event === "started") {
        suites += 1;
        total += numberField(message.test_count);
      }
      if (message.event === "failed" || message.event === "ok") {
        failed += numberField(message.failed);
        durationSeconds += numberField(message.exec_time);
      }
      continue;
    }

    if (message.type === "test" && message.event === "failed") {
      failures.push({
        suite: stringField(message.name).split("::").slice(0, -1).join("::"),
        name: stringField(message.name),
        excerpt: stringField(message.stdout),
      });
      continue;
    }

    if (message.reason === "compiler-message" && isRecord(message.message)) {
      const rendered = stringField(message.message.rendered);
      if (rendered) compileErrors.push(rendered);
    }
  }

  if (failures.length === 0 && compileErrors.length > 0) {
    failures.push({ suite: "cargo check", name: "compile-error", excerpt: compileErrors.join("\n") });
    suites ||= 1;
    total ||= 1;
    failed ||= 1;
  }

  failed ||= failures.length;
  suites ||= 1;
  total ||= Math.max(failed, failures.length);

  return { failed, total, suites, durationSeconds, failures };
}

async function renderExcerpt(
  excerpt: string,
  command: string,
  store?: RspElisionStore,
): Promise<{ text: string; handle?: `el:${string}`; bytesElided: number }> {
  const bytes = Buffer.from(excerpt);
  if (bytes.length <= EXCERPT_LIMIT_BYTES) return { text: excerpt, bytesElided: 0 };
  if (!store) throw new Error("over-limit test failure excerpt requires an elision store");

  const handle = await store.mint(bytes, {
    command,
    loss: { level: "brief", bytes_elided: bytes.length },
  });
  const head = bytes.subarray(0, EXCERPT_LIMIT_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  const omitted = bytes.length - Buffer.byteLength(head);
  return {
    text: `${head}\n… elided ${omitted} bytes (+${bytes.length}) — rsp show ${handle}`,
    handle,
    bytesElided: bytes.length,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function failureMessage(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => String(item)).filter(Boolean).join("\n");
}

function formatDuration(seconds: number): string {
  return `${Number(seconds.toFixed(1))}s`;
}

function durationFromMs(start: number, end: number): number {
  return start > 0 && end > start ? (end - start) / 1000 : 0;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
