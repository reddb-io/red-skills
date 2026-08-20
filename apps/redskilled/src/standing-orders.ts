/**
 * standing-orders — daemon-owned per-project append-only instruction register.
 *
 * **ADR 0156**: Standing orders are the operator's reflex mechanism: an instruction
 * the operator catches themselves repeating gets appended before acting, and every
 * subsequent Worker inherits it without restatement. The register is append-only,
 * numbered, and drain-scoped — not a second permanent home that competes with
 * CLAUDE.md.
 *
 * **Design**:
 * - Per-project, keyed by project label
 * - Append-only: orders are never mutated or renumbered
 * - Numbered: each order gets a sequential number
 * - Injected verbatim into every Worker brief at admission and on resume
 *
 * **Storage**: One TOONL file per project under the daemon's home directory.
 * The file is append-only: new orders are appended as TOONL rows.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { encodeToonlLines } from "@reddb-io/toon";

/** The standing orders file name prefix */
export const REDSKILLED_STANDING_ORDERS_FILE = "redskilled.orders.toonl";

export interface StandingOrder {
  readonly version: 1;
  readonly n: number;
  readonly text: string;
  readonly ts: string;
}

export interface StandingOrdersShowOutput {
  readonly project_label: string;
  readonly orders: readonly StandingOrder[];
}

export interface StandingOrdersAppendInput {
  readonly text: string;
}

export interface StandingOrdersStore {
  readonly show: (projectLabel: string) => Promise<StandingOrdersShowOutput>;
  readonly append: (projectLabel: string, text: string) => Promise<StandingOrder>;
}

/**
 * Resolve the path to a project's standing orders file.
 */
export function standingOrdersPath(homeDir: string, projectLabel: string): string {
  const safeLabel = projectLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(redskilledHomeDir(homeDir), "orders", `${safeLabel}.toonl`);
}

/**
 * Derive the home directory from the event lane path.
 * The event lane path is: <homeDir>/.red/redskilled/redskilled.log.toonl
 * So we need to go up two levels to get homeDir.
 */
export function deriveHomeDirFromEventLanePath(eventLanePath: string): string {
  const dirnameOfEventLane = dirname(eventLanePath); // <homeDir>/.red/redskilled
  const parentDir = dirname(dirnameOfEventLane); // <homeDir>
  return parentDir;
}

/**
 * Read standing orders for a project. Returns empty array if no orders exist.
 */
async function readStandingOrders(path: string): Promise<StandingOrder[]> {
  try {
    const content = await readFile(path, "utf8");
    if (content.trim() === "") return [];
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    return lines.map((line) => JSON.parse(line) as StandingOrder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Encode a standing order to a TOONL string.
 */
function encodeOrder(order: StandingOrder): string {
  return encodeToonlLines({ trailer: false }).push(order as unknown as Record<string, string | number | boolean | null>);
}

/**
 * Create a standing orders store.
 */
export function createStandingOrdersStore(homeDir: string): StandingOrdersStore {
  return {
    show: async (projectLabel: string): Promise<StandingOrdersShowOutput> => {
      const path = standingOrdersPath(homeDir, projectLabel);
      const orders = await readStandingOrders(path);
      return { project_label: projectLabel, orders };
    },
    append: async (projectLabel: string, text: string): Promise<StandingOrder> => {
      const path = standingOrdersPath(homeDir, projectLabel);
      const orders = await readStandingOrders(path);
      const n = orders.length + 1;
      const order: StandingOrder = {
        version: 1,
        n,
        text,
        ts: new Date().toISOString(),
      };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const line = encodeOrder(order);
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      return order;
    },
  };
}

/**
 * Format standing orders as a string for injection into a Worker brief.
 * Returns empty string if no orders exist.
 */
export function formatStandingOrdersBrief(orders: readonly StandingOrder[]): string {
  if (orders.length === 0) return "";
  const header = "## Standing Orders\n";
  const items = orders.map((o) => `${o.n}. ${o.text}`).join("\n");
  return `${header}${items}\n`;
}