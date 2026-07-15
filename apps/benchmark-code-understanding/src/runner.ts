import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { encode, type JsonValue } from "@reddb-io/toon";
import type { CorpusCase, CorpusId } from "./corpus.js";
import { loadCorpus } from "./corpus.js";
import { emptyTokenUsage, emptyToolCounts, parseAgentJsonl } from "./report.js";
import type { ArmId, RunRecord, RunnerId } from "./types.js";

export interface RunBenchmarkOptions {
  runner: RunnerId;
  corpus: CorpusId;
  arms: ArmId[];
  runs: number;
  workdir: string;
  out: string;
  dryRun?: boolean;
}

export interface DoctorCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  schema_version: "redskills.code_understanding_bench.doctor.v1";
  generated_at: string;
  checks: DoctorCheck[];
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<RunRecord[]> {
  const corpus = loadCorpus(options.corpus);
  const records: RunRecord[] = [];
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  await writeFile(options.out, "", "utf8");

  for (const testCase of corpus) {
    const repoPath = repoPathFor(options.workdir, testCase);
    if (!options.dryRun) await ensureRepo(testCase, repoPath);
    for (const arm of options.arms) {
      if (!options.dryRun) await prepareArm(arm, repoPath);
      for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
        const record = await runOne({ ...options, arm, testCase, repoPath, runIndex });
        records.push(record);
        await appendToonl(options.out, record);
      }
    }
  }

  return records;
}

export async function doctor(root = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(await binaryCheck("claude", "Claude headless runner"));
  checks.push(await binaryCheck("codex", "Codex runner"));
  checks.push(await binaryCheck("git", "Repo clone support"));
  checks.push(await binaryCheck("npx", "CodeGraph fallback via npx"));
  checks.push(await binaryCheck("typescript-language-server", "TypeScript LSP for code-nav", "warn"));
  checks.push(await binaryCheck("pyright-langserver", "Python LSP for code-nav", "warn"));
  checks.push(await binaryCheck("gopls", "Go LSP for code-nav", "warn"));
  checks.push(await binaryCheck("rust-analyzer", "Rust LSP for code-nav", "warn"));

  const bundle = codeNavBundlePath(workspaceRoot(root));
  checks.push({
    id: "code-nav-bundle",
    status: existsSync(bundle) ? "pass" : "warn",
    detail: existsSync(bundle)
      ? `found ${bundle}`
      : `missing ${bundle}; run pnpm --filter @reddb-io/code-nav-mcp build before redskills arm`,
  });

  return {
    schema_version: "redskills.code_understanding_bench.doctor.v1",
    generated_at: new Date().toISOString(),
    checks,
  };
}

interface RunOneInput extends RunBenchmarkOptions {
  arm: ArmId;
  testCase: CorpusCase;
  repoPath: string;
  runIndex: number;
}

async function runOne(input: RunOneInput): Promise<RunRecord> {
  const runDir = join(input.workdir, "runs", input.testCase.id, input.arm, String(input.runIndex));
  const logPath = join(runDir, "agent.jsonl");
  const mcpConfigPath = join(runDir, "mcp.json");
  await mkdir(runDir, { recursive: true });

  const mcpConfig = buildMcpConfig(input.arm, input.repoPath);
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");
  const invocation = buildRunnerInvocation(input.runner, input.arm, input.testCase.question, input.repoPath, mcpConfigPath, runDir);

  if (input.dryRun) {
    return baseRecord(input, {
      status: "planned",
      durationMs: 0,
      exitCode: null,
      signal: null,
      logPath,
      mcpConfigPath,
      command: [invocation.command, ...invocation.args],
      metrics: { tools: emptyToolCounts(), tokens: emptyTokenUsage(), cost_usd: null },
    });
  }

  const started = performance.now();
  const result = await spawnToFile(invocation.command, invocation.args, {
    cwd: input.repoPath,
    logPath,
    env: { ...process.env, ...(invocation.env ?? {}) },
  });
  const durationMs = Math.round(performance.now() - started);
  const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
  const metrics = parseAgentJsonl(log);
  return baseRecord(input, {
    status: result.code === 0 ? "pass" : "fail",
    durationMs,
    exitCode: result.code,
    signal: result.signal,
    logPath,
    mcpConfigPath,
    command: [invocation.command, ...invocation.args],
    metrics,
    error: result.code === 0 ? undefined : result.stderr.slice(0, 2000),
  });
}

function baseRecord(
  input: RunOneInput,
  data: {
    status: RunRecord["status"];
    durationMs: number;
    exitCode: number | null;
    signal: string | null;
    logPath: string | null;
    mcpConfigPath: string | null;
    command: string[];
    metrics: RunRecord["metrics"];
    error?: string;
  },
): RunRecord {
  return {
    schema_version: "redskills.code_understanding_bench.run.v1",
    generated_at: new Date().toISOString(),
    benchmark: "code-understanding",
    runner: input.runner,
    arm: input.arm,
    corpus: input.corpus,
    case_id: input.testCase.id,
    language: input.testCase.language,
    repo: input.testCase.repo,
    repo_path: input.repoPath,
    question: input.testCase.question,
    run_index: input.runIndex,
    status: data.status,
    duration_ms: data.durationMs,
    exit_code: data.exitCode,
    signal: data.signal,
    log_path: data.logPath,
    mcp_config_path: data.mcpConfigPath,
    command: data.command,
    metrics: data.metrics,
    ...(data.error ? { error: data.error } : {}),
  };
}

function repoPathFor(workdir: string, testCase: CorpusCase): string {
  return join(resolve(workdir), "repos", testCase.id);
}

async function ensureRepo(testCase: CorpusCase, repoPath: string): Promise<void> {
  if (existsSync(join(repoPath, ".git"))) return;
  await mkdir(dirname(repoPath), { recursive: true });
  await spawnChecked("git", ["clone", "--depth", "1", testCase.repo, repoPath], process.cwd());
}

async function prepareArm(arm: ArmId, repoPath: string): Promise<void> {
  if (arm !== "codegraph") return;
  if (existsSync(join(repoPath, ".codegraph", "codegraph.db"))) return;
  const [command, ...baseArgs] = codegraphCommand();
  await spawnChecked(command, [...baseArgs, "init", "-i"], repoPath);
}

function buildMcpConfig(arm: ArmId, repoPath: string): unknown {
  if (arm === "none") return { mcpServers: {} };
  if (arm === "codegraph") {
    const [command, ...baseArgs] = codegraphCommand();
    return {
      mcpServers: {
        codegraph: {
          command,
          args: [...baseArgs, "serve", "--mcp", "--path", repoPath],
        },
      },
    };
  }
  return {
    mcpServers: {
      "code-nav": {
        command: process.execPath,
        args: [codeNavBundlePath(workspaceRoot(process.cwd()))],
        env: { CODE_NAV_ROOT: repoPath },
      },
    },
  };
}

function codeNavBundlePath(root: string): string {
  return join(resolve(root), "dist", "code-nav-mcp.bundle.min.mjs");
}

function buildRunnerInvocation(
  runner: RunnerId,
  arm: ArmId,
  prompt: string,
  repoPath: string,
  mcpConfigPath: string,
  runDir: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  if (runner === "codex") {
    const configArgs = codexMcpConfigArgs(arm, repoPath);
    return {
      command: "codex",
      args: [
        "exec",
        "--json",
        ...configArgs,
        "-C",
        repoPath,
        "--sandbox",
        "danger-full-access",
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-last-message",
        join(runDir, "last-message.txt"),
        prompt,
      ],
    };
  }
  return {
    command: "claude",
    args: [
      "--model",
      "opus",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--print",
      prompt,
    ],
  };
}

function codexMcpConfigArgs(arm: ArmId, repoPath: string): string[] {
  const args = ["--ignore-user-config"];
  if (arm === "none") return args;
  const root = workspaceRoot(process.cwd());
  if (arm === "redskills") {
    const redskillsBundle = codeNavBundlePath(root);
    args.push(
      "-c",
      `mcp_servers."code-nav".command=${tomlString(process.execPath)}`,
      "-c",
      `mcp_servers."code-nav".args=[${tomlString(redskillsBundle)}]`,
      "-c",
      `mcp_servers."code-nav".env={CODE_NAV_ROOT=${tomlString(repoPath)}}`,
    );
  }
  if (arm === "codegraph") {
    const [command, ...baseArgs] = codegraphCommand();
    const fullArgs = [...baseArgs, "serve", "--mcp", "--path", repoPath];
    args.push(
      "-c",
      `mcp_servers.codegraph.command=${tomlString(command)}`,
      "-c",
      `mcp_servers.codegraph.args=[${fullArgs.map(tomlString).join(",")}]`,
    );
  }
  return args;
}

async function spawnChecked(command: string, args: string[], cwd: string): Promise<void> {
  const result = await spawnToFile(command, args, { cwd });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function spawnToFile(
  command: string,
  args: string[],
  options: { cwd: string; logPath?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  if (options.logPath) await mkdir(dirname(options.logPath), { recursive: true });
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", async (code, signal) => {
      if (options.logPath) await writeFile(options.logPath, stdout, "utf8");
      resolvePromise({ code, signal, stderr });
    });
  });
}

async function binaryCheck(command: string, label: string, missingStatus: "warn" | "fail" = "fail"): Promise<DoctorCheck> {
  const result = await spawnToFile("sh", ["-c", `command -v ${shellQuote(command)}`], { cwd: process.cwd() });
  return {
    id: command,
    status: result.code === 0 ? "pass" : missingStatus,
    detail: result.code === 0 ? `${label}: available` : `${label}: ${command} not found on PATH`,
  };
}

async function appendToonl(path: string, record: RunRecord): Promise<void> {
  await appendFile(path, `${encode([record] as unknown as JsonValue).trimEnd()}\n`, "utf8");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codegraphCommand(): string[] {
  const raw = process.env.RED_CODE_BENCH_CODEGRAPH_CMD;
  if (!raw) return ["npx", "-y", "@colbymchenry/codegraph"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string") && parsed.length > 0) {
      return parsed;
    }
  } catch {
    // Fall through to whitespace split for simple values like "codegraph".
  }
  const split = raw.split(/\s+/).filter(Boolean);
  return split.length > 0 ? split : ["npx", "-y", "@colbymchenry/codegraph"];
}

function workspaceRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}
