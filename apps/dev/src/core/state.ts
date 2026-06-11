import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AfkStateSchema, type AfkState } from "../types/state.js";

export function defaultState(): AfkState {
  return AfkStateSchema.parse({});
}

export function parseState(data: unknown): AfkState {
  return AfkStateSchema.parse(data ?? {});
}

export async function readState(path: string): Promise<AfkState> {
  try {
    const text = await readFile(path, "utf8");
    return parseState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("empty state field");
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export async function writeStateAtomic(path: string, state: AfkState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(AfkStateSchema.parse(state))}
`, "utf8");
  await rename(tmp, path);
}

export async function initState(path: string, updates: Record<string, unknown> = {}): Promise<AfkState> {
  const state = defaultState() as unknown as Record<string, unknown>;
  state.version = 1;
  state.envelope = { posted: false };
  for (const [key, value] of Object.entries(updates)) setDotted(state, key, value);
  const parsed = parseState(state);
  await writeStateAtomic(path, parsed);
  return parsed;
}

export async function updateState(path: string, updates: Record<string, unknown>): Promise<AfkState> {
  const state = (await readState(path)) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) setDotted(state, key, value);
  const parsed = parseState(state);
  await writeStateAtomic(path, parsed);
  return parsed;
}

export function isStateLive(state: Pick<AfkState, "pid">, kill: (pid: number, signal?: 0) => boolean = defaultKill0): boolean {
  return Number.isInteger(state.pid) && state.pid > 0 && kill(state.pid, 0);
}

function defaultKill0(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
