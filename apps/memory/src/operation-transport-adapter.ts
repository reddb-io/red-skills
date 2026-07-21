import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ZodError } from "zod";
import {
  executeReadOnlyMemoryOperation,
  type MemoryOperationContext,
  type MemoryOperationInputFieldBinding,
  type MemoryOperationTransport,
  type MemoryOperationTransportInput,
  type ReadOnlyMemoryOperation,
} from "./operations.js";

export function listMemoryOperationsForTransport(
  operations: readonly ReadOnlyMemoryOperation[],
  transport: MemoryOperationTransport,
): ReadOnlyMemoryOperation[] {
  return operations.filter((operation) => operation.transports.includes(transport));
}

export class MemoryOperationTransportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MemoryOperationTransportError";
  }
}

export function bindMemoryOperationInput(
  operation: ReadOnlyMemoryOperation,
  transportInput: MemoryOperationTransportInput,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const field of operation.inputBinding.fields) {
    const value = bindField(field, transportInput);
    if (value !== undefined) input[field.field] = value;
  }

  if (operation.inputBinding.customBind) {
    Object.assign(input, operation.inputBinding.customBind.bind(transportInput));
  }

  for (const field of operation.inputBinding.fields) {
    if (!field.required) continue;
    const value = input[field.field];
    if (value === undefined || value === "") {
      throw new MemoryOperationTransportError(`${field.field} is required`);
    }
  }

  return input;
}

export async function executeMemoryOperationFromTransport(
  operation: ReadOnlyMemoryOperation,
  ctx: MemoryOperationContext,
  transportInput: MemoryOperationTransportInput,
): Promise<unknown> {
  try {
    return await executeReadOnlyMemoryOperation(
      operation.id,
      ctx,
      bindMemoryOperationInput(operation, transportInput),
    );
  } catch (err) {
    if (err instanceof MemoryOperationTransportError) throw err;
    if (err instanceof ZodError) {
      throw new MemoryOperationTransportError(err.issues[0]?.message ?? "invalid input");
    }
    throw err;
  }
}

export function queryObjectFromSearchParams(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

export function viewerHtml(output: unknown): string {
  if (isRecord(output) && typeof output.html === "string") return output.html;
  throw new Error("viewer operation did not return an html artifact");
}

export async function writeViewerArtifact(
  operation: ReadOnlyMemoryOperation,
  output: unknown,
  transportInput: MemoryOperationTransportInput,
): Promise<string> {
  if (operation.outputKind.kind !== "viewer") {
    throw new Error(`${operation.id} is not a viewer operation`);
  }
  const outPath = resolveViewerOutPath(operation, transportInput);
  if (!outPath) throw new MemoryOperationTransportError("out is required");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, viewerHtml(output), "utf8");
  return outPath;
}

export function viewerCliSummary(
  operation: ReadOnlyMemoryOperation,
  output: unknown,
  outPath: string,
): string {
  const lines = [`memory: ${cliViewerLabel(operation)} written ${outPath}`];
  if (isRecord(output)) {
    const brief = isRecord(output.brief) ? output.brief : undefined;
    if (typeof brief?.status === "string") lines.push(`  status: ${brief.status}`);
    if (Array.isArray(brief?.citations)) lines.push(`  citations: ${brief.citations.length}`);
    const contract = isRecord(output.contract) ? output.contract : undefined;
    if (typeof contract?.consumes === "string") lines.push(`  contract: ${contract.consumes}`);
  }
  return `${lines.join("\n")}\n`;
}

function bindField(
  field: MemoryOperationInputFieldBinding,
  input: MemoryOperationTransportInput,
): unknown {
  if (field.field === "cache" && input.flags["no-cache"] === true) return "off";

  if (field.sources.includes("flag")) {
    const value = firstDefined(input.flags, fieldKeyCandidates(field.field, "flag"));
    if (value !== undefined) return coerce(value, field.type);
  }

  if (field.sources.includes("query")) {
    const value = firstDefined(input.query, fieldKeyCandidates(field.field, "query"));
    if (value !== undefined) return coerce(value, field.type);
  }

  if (isRecord(input.body)) {
    const value = firstDefined(input.body, fieldKeyCandidates(field.field, "query"));
    if (value !== undefined) return coerce(value, field.type);
  }

  if (field.sources.includes("positional")) {
    const position = field.position ?? 0;
    const value = field.variadic
      ? input.positional.slice(position).join(" ").trim()
      : input.positional[position];
    if (value) return coerce(value, field.type);
  }

  return undefined;
}

function resolveViewerOutPath(
  operation: ReadOnlyMemoryOperation,
  input: MemoryOperationTransportInput,
): string | undefined {
  const sink = operation.outputKind.kind === "viewer" ? operation.outputKind.fileSink : undefined;
  if (!sink) return undefined;
  const custom = sink.customBind?.bind(input);
  if (custom) return custom;
  const raw = firstDefined(
    {
      ...(sink.sources.includes("flag") ? input.flags : {}),
      ...(sink.sources.includes("query") ? input.query : {}),
    },
    fieldKeyCandidates(sink.field, "flag"),
  );
  if (typeof raw === "string" && raw.length > 0) return raw;
  return join(
    input.rootDir ?? process.cwd(),
    ".red/memory",
    `${operation.renderer.cli.command.replaceAll(" ", "-")}.html`,
  );
}

function fieldKeyCandidates(field: string, source: "flag" | "query"): string[] {
  const kebab = field.replaceAll("_", "-");
  const candidates = [field, kebab];
  if (field === "budget_chars") candidates.push("budget");
  if (field === "session_id") candidates.push("session");
  if (field === "comparison") candidates.push("range");
  if (field === "changed_files") candidates.push("changed-file", "changed-files");
  if (field === "node") candidates.push("rid");
  if (field === "changes") candidates.push("change");
  if (source === "query" && field === "query") candidates.push("q");
  if (source === "query" && ["goal", "focus", "task"].includes(field)) {
    candidates.push("query", "q");
  }
  return [...new Set(candidates)];
}

function firstDefined(
  values: Readonly<Record<string, unknown>>,
  candidates: readonly string[],
): unknown {
  for (const candidate of candidates) {
    if (values[candidate] !== undefined) return values[candidate];
  }
  return undefined;
}

function coerce(value: unknown, type: MemoryOperationInputFieldBinding["type"]): unknown {
  if (Array.isArray(value)) {
    if (type === "string-array") return value.map(String);
    if (type === "object-array") return value;
    value = value[value.length - 1];
  }
  if (value === undefined || value === "") return undefined;
  if (type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value === "true" || value === "1";
  }
  if (type === "string-array") return String(value).split(",").filter(Boolean);
  return value;
}

function cliViewerLabel(operation: ReadOnlyMemoryOperation): string {
  if (operation.id === "memory.smart-search-viewer") return "smart-search viewer";
  return operation.title.replace(/^Memory /, "").replace(/^Doc /, "doc ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
