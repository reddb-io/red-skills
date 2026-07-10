import { spawn } from "node:child_process";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { RspElisionStore, type RspLossLevel } from "./elision-store.js";

export type GitSubcommand = "status" | "log" | "diff" | "commit" | "push";

export interface RecordedGitContract {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

export interface GitRenderOptions {
  level: RspLossLevel;
  store?: RspElisionStore;
}

export interface GitRenderResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  payload?: JsonObject;
  mintedHandle?: `el:${string}`;
  bytesElided?: number;
  rowsElided?: number;
}

export async function runGitWrapper(argv: readonly string[], options: GitRenderOptions): Promise<GitRenderResult> {
  const subcommand = parseGitSubcommand(argv);
  const contract = await collectGitContract(subcommand, argv.slice(1));
  return renderGitContract(argv, contract, options);
}

export async function renderGitContract(
  command: readonly string[],
  contract: RecordedGitContract,
  options: GitRenderOptions,
): Promise<GitRenderResult> {
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    return {
      stdout: Buffer.from(contract.stdout),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
    };
  }

  const subcommand = parseGitSubcommand(command);
  const payload = parseGitPayload(subcommand, command, contract.stdout);
  if (payload === "git empty\n") {
    return {
      stdout: Buffer.from(payload),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
    };
  }

  const fullToon = encode(payload);
  if (options.level !== "terse") {
    return {
      stdout: Buffer.from(fullToon),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
      payload,
    };
  }

  const terse = tersePayload(payload);
  if (!terse) {
    return {
      stdout: Buffer.from(fullToon),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
      payload,
    };
  }

  const bytesElided = Buffer.byteLength(fullToon);
  const handle = await options.store?.mint(Buffer.from(fullToon), {
    command: command.join(" "),
    loss: { level: "terse", bytes_elided: bytesElided },
  });
  if (!handle) throw new Error("terse git output requires an elision store");

  const marker = `… elided ${terse.rowsElided} rows (+${bytesElided}) — rsp show ${handle}\n`;
  return {
    stdout: Buffer.from(`${encode(terse.payload)}\n${marker}`),
    stderr: Buffer.from(contract.stderr),
    status: contract.status,
    signal: contract.signal,
    payload: terse.payload,
    mintedHandle: handle,
    bytesElided,
    rowsElided: terse.rowsElided,
  };
}

function parseGitSubcommand(argv: readonly string[]): GitSubcommand {
  if (argv[0] !== "git") throw new Error("expected rsp git <subcommand>");
  const subcommand = argv[1];
  if (subcommand === "status" || subcommand === "log" || subcommand === "diff" || subcommand === "commit" || subcommand === "push") {
    return subcommand;
  }
  throw new Error(`unsupported git subcommand: ${subcommand ?? ""}`);
}

function machineArgs(subcommand: GitSubcommand, rest: readonly string[]): string[] {
  const passthrough = rest.slice(1);
  switch (subcommand) {
    case "status":
      return ["status", "--porcelain=v2", "-z", "-b", ...passthrough];
    case "log":
      return ["log", "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s", "-z", ...passthrough];
    case "diff":
      return ["diff", "--numstat", "-z", ...passthrough];
    case "commit":
      return ["commit", ...passthrough];
    case "push":
      return ["push", "--porcelain", ...passthrough];
  }
}

async function collectGitContract(subcommand: GitSubcommand, rest: readonly string[]): Promise<RecordedGitContract> {
  const child = spawn("git", machineArgs(subcommand, [subcommand, ...rest]), { stdio: ["ignore", "pipe", "pipe"] });
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

function parseGitPayload(subcommand: GitSubcommand, command: readonly string[], stdout: string): JsonObject | "git empty\n" {
  switch (subcommand) {
    case "status":
      return parseStatus(command, stdout);
    case "log":
      return parseLog(command, stdout);
    case "diff":
      return parseDiff(command, stdout);
    case "commit":
      return parseCommit(command, stdout);
    case "push":
      return parsePush(command, stdout);
  }
}

function parseStatus(command: readonly string[], stdout: string): JsonObject | "git empty\n" {
  let branch = "";
  const rows: JsonObject[] = [];
  for (const raw of stdout.split("\0")) {
    if (!raw) continue;
    if (raw.startsWith("# branch.head ")) {
      branch = raw.slice("# branch.head ".length);
      continue;
    }
    if (!raw.startsWith("1 ")) continue;
    const parts = raw.split(" ");
    const xy = parts[1] ?? "..";
    const path = parts.slice(8).join(" ");
    rows.push({
      path,
      index: xy[0] ?? ".",
      worktree: xy[1] ?? ".",
      state: statusState(xy),
    });
  }
  if (rows.length === 0) return "git empty\n";
  const counts = countBy(rows, "state");
  return {
    command: command.join(" "),
    branch,
    rows,
    summary: `${rows.length} changes: ${counts.added ?? 0} added, ${counts.modified ?? 0} modified, ${counts.deleted ?? 0} deleted`,
  };
}

function parseLog(command: readonly string[], stdout: string): JsonObject {
  const commits = stdout.split("\0").filter(Boolean).map((record) => {
    const fields = record.replace(/^\x1e/, "").split("\x1f");
    return {
      hash: fields[0] ?? "",
      short: fields[1] ?? "",
      author: fields[2] ?? "",
      date: fields[3] ?? "",
      subject: fields[4] ?? "",
    };
  });
  return { command: command.join(" "), commits, summary: `${commits.length} commits` };
}

function parseDiff(command: readonly string[], stdout: string): JsonObject {
  const fields = stdout.split("\0").filter(Boolean);
  const files = fields.map((entry) => {
    const [added, deleted, path] = entry.split("\t");
    return {
      path: path ?? "",
      added: added === "-" ? null : Number(added ?? 0),
      deleted: deleted === "-" ? null : Number(deleted ?? 0),
    };
  });
  const totals = files.reduce((acc, file) => {
    acc.added += typeof file.added === "number" ? file.added : 0;
    acc.deleted += typeof file.deleted === "number" ? file.deleted : 0;
    return acc;
  }, { added: 0, deleted: 0 });
  return { command: command.join(" "), files, summary: `${files.length} files, +${totals.added} -${totals.deleted}` };
}

function parseCommit(command: readonly string[], stdout: string): JsonObject {
  const first = stdout.split("\n")[0] ?? "";
  const match = /^\[([^ ]+) ([0-9a-f]+)\] (.+)$/.exec(first);
  const changed = /(\d+) files? changed/.exec(stdout);
  const insertions = /(\d+) insertions?\(\+\)/.exec(stdout);
  const deletions = /(\d+) deletions?\(-\)/.exec(stdout);
  const branch = match?.[1] ?? "";
  const commit = match?.[2] ?? "";
  const filesChanged = Number(changed?.[1] ?? 0);
  const added = Number(insertions?.[1] ?? 0);
  const deleted = Number(deletions?.[1] ?? 0);
  return {
    command: command.join(" "),
    branch,
    commit,
    subject: match?.[3] ?? "",
    files_changed: filesChanged,
    insertions: added,
    deletions: deleted,
    summary: `commit ${commit} on ${branch}: ${filesChanged} files, +${added} -${deleted}`,
  };
}

function parsePush(command: readonly string[], stdout: string): JsonObject {
  const lines = stdout.split("\n").filter(Boolean);
  const remote = lines.find((line) => line.startsWith("To "))?.slice(3) ?? "";
  const refs = lines.filter((line) => line.includes("\t")).map((line) => {
    const [flag, refspec, summary = ""] = line.split("\t");
    const [from, to] = (refspec ?? "").split(":");
    return { flag: flag ?? "", from: from ?? "", to: to ?? "", summary };
  });
  const pushed = refs.find((ref) => ref.flag !== "=") ?? refs[0];
  const branch = pushed?.to.startsWith("refs/heads/") ? pushed.to.slice("refs/heads/".length) : (pushed?.to ?? "");
  const commitCount = pushed?.summary.includes("..") ? 1 : 0;
  return {
    command: command.join(" "),
    remote,
    refs,
    summary: `pushed ${branch} -> ${remote} +${commitCount} commits`,
  };
}

function statusState(xy: string): string {
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("M")) return "modified";
  return "changed";
}

function countBy(rows: readonly JsonObject[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? "");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function tersePayload(payload: JsonObject): { payload: JsonObject; rowsElided: number } | null {
  for (const key of ["rows", "commits", "files", "refs"] as const) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 1) {
      return {
        payload: { ...payload, [key]: value.slice(0, 1) as JsonValue },
        rowsElided: value.length - 1,
      };
    }
  }
  return null;
}
