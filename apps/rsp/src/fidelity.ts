import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { encodingForModel } from "js-tiktoken";
import { renderGitContract, type GitRenderResult, type RecordedGitContract } from "./git-wrapper.js";
import { renderGhContract } from "./gh-wrapper.js";
import { renderTestContract } from "./test-wrapper.js";
import { renderCatContract } from "./cat-wrapper.js";
import { renderExecContract } from "./exec-wrapper.js";
import { renderAutomaticOutput } from "./automatic-output-policy.js";
import type { RspMintStore } from "./git-wrapper.js";
import type { RspLossLevel } from "./elision-store.js";

export interface FidelityAssertion {
  question: string;
  path: string;
  expected: unknown;
}

export interface FidelityFixture {
  name: string;
  file: string;
  command: string[];
  large_output?: boolean;
  automatic_policy?: {
    size_threshold_bytes: number;
    repetition_threshold_rows: number;
    top_rows: number;
  };
  recorded: RecordedGitContract;
  expected: unknown;
  assertions: FidelityAssertion[];
}

export interface AssertionFailure {
  question: string;
  expected: unknown;
  actual: unknown;
}

export interface FidelityRunOptions {
  level: RspLossLevel;
  /** Fidelity replays renderers offline, so it needs the mint port and nothing else. */
  store: RspMintStore;
}

export interface FidelityRunResult extends GitRenderResult {
  assertionFailures: AssertionFailure[];
  tokenDelta: number;
}

const tokenizer = encodingForModel("gpt-4o");

export async function discoverFidelityFixtures(root: string): Promise<FidelityFixture[]> {
  const files = await discoverJsonFiles(root);
  const fixtures = await Promise.all(files.map(async (file) => parseFixture(await readFile(file, "utf8"), file)));
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runFidelityFixture(
  fixture: FidelityFixture,
  options: FidelityRunOptions,
): Promise<FidelityRunResult> {
  const result = await renderFixture(fixture, options);
  const assertionFailures = result.status === 0 && result.stdout.length > 0
    ? evaluateAssertions(decodeRenderOutput(result), fixture.assertions)
    : [];
  return {
    ...result,
    assertionFailures,
    tokenDelta: tokenDelta(fixture.recorded.stdout, result.stdout.toString("utf8")),
  };
}

export async function renderFixture(
  fixture: FidelityFixture,
  options: FidelityRunOptions,
): Promise<GitRenderResult> {
  if (fixture.command[0] === "automatic" && fixture.command[1] === "output") {
    const automaticLevel = options.level === "lossless" ? "automatic" : options.level;
    const result = await renderAutomaticOutput(Buffer.from(fixture.recorded.stdout), {
      command: fixture.command.slice(2).join(" "),
      level: automaticLevel,
      store: options.store,
      sizeThresholdBytes: fixture.automatic_policy?.size_threshold_bytes,
      repetitionThresholdRows: fixture.automatic_policy?.repetition_threshold_rows,
      topRows: fixture.automatic_policy?.top_rows,
    });
    return {
      stdout: result.stdout,
      stderr: Buffer.from(fixture.recorded.stderr),
      status: fixture.recorded.status,
      signal: fixture.recorded.signal,
      mintedHandle: result.handle,
      bytesElided: result.bytesElided,
      rawOutput: Buffer.from(fixture.recorded.stdout),
    };
  }
  if (fixture.command[0] === "vitest" || fixture.command[0] === "cargo") {
    return await renderTestContract(fixture.command, fixture.recorded, options);
  }
  if (fixture.command[0] === "exec") {
    return await renderExecContract(fixture.command.slice(2).join(" "), fixture.recorded, {
      ...options,
      heavyByteThreshold: fixture.large_output === true ? 1 : undefined,
    });
  }
  if (fixture.command[0] === "cat") return await renderCatContract(fixture.command, fixture.recorded, options);
  if (fixture.command[0] === "gh") return await renderGhContract(fixture.command, fixture.recorded, options);
  if (fixture.command[0] !== "git") throw new Error(`unsupported fixture command: ${fixture.command.join(" ")}`);
  return await renderGitContract(fixture.command, fixture.recorded, options);
}

function decodeRenderOutput(result: GitRenderResult): unknown {
  if (result.oneLine) return result.stdout.toString("utf8").replace(/\n$/, "");
  return readDecodedToon(result.stdout);
}

function readDecodedToon(stdout: Buffer): unknown {
  const text = stdout.toString("utf8");
  if (text === "git empty\n") return "git empty\n";
  if (text.startsWith("stdout summary\n")) return text;
  if (text.startsWith("0 ")) return text;
  const toon = text.split("\n").filter((line) => !line.startsWith("… elided ")).join("\n");
  return decode(toon);
}

function evaluateAssertions(decoded: unknown, assertions: readonly FidelityAssertion[]): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  for (const assertion of assertions) {
    if (typeof decoded === "string") {
      if (!decoded.includes(String(assertion.expected))) {
        failures.push({ question: assertion.question, expected: assertion.expected, actual: decoded });
      }
      continue;
    }
    const actual = getPath(decoded, assertion.path);
    if (!Object.is(actual, assertion.expected)) {
      failures.push({ question: assertion.question, expected: assertion.expected, actual });
    }
  }
  return failures;
}

function getPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (segment === "length" && Array.isArray(cursor)) {
      cursor = cursor.length;
    } else if (segment === "length" && isRecord(cursor)) {
      cursor = Object.keys(cursor).length;
    } else if (/^\d+$/.test(segment) && Array.isArray(cursor)) {
      cursor = cursor[Number(segment)];
    } else if (isRecord(cursor)) {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function tokenDelta(original: string, filtered: string): number {
  const before = tokenizer.encode(original).length;
  const after = tokenizer.encode(filtered).length;
  if (before === 0) return 0;
  return ((before - after) / before) * 100;
}

async function discoverJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await discoverJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

function parseFixture(raw: string, file: string): FidelityFixture {
  const parsed = JSON.parse(raw) as unknown;
  if (!isFixture(parsed)) throw new Error(`invalid fidelity fixture: ${file}`);
  return { ...parsed, file };
}

function isFixture(value: unknown): value is FidelityFixture {
  return isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.command) &&
    value.command.every((part) => typeof part === "string") &&
    (!Object.prototype.hasOwnProperty.call(value, "large_output") || typeof value.large_output === "boolean") &&
    (!Object.prototype.hasOwnProperty.call(value, "automatic_policy") || isAutomaticPolicy(value.automatic_policy)) &&
    isRecord(value.recorded) &&
    typeof value.recorded.stdout === "string" &&
    typeof value.recorded.stderr === "string" &&
    (typeof value.recorded.status === "number" || value.recorded.status === null) &&
    (typeof value.recorded.signal === "string" || value.recorded.signal === null) &&
    Array.isArray(value.assertions) &&
    value.assertions.every(isAssertion);
}

function isAutomaticPolicy(value: unknown): value is NonNullable<FidelityFixture["automatic_policy"]> {
  return isRecord(value) &&
    typeof value.size_threshold_bytes === "number" &&
    typeof value.repetition_threshold_rows === "number" &&
    typeof value.top_rows === "number";
}

function isAssertion(value: unknown): value is FidelityAssertion {
  return isRecord(value) &&
    typeof value.question === "string" &&
    typeof value.path === "string" &&
    Object.prototype.hasOwnProperty.call(value, "expected");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
