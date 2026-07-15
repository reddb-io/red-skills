import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHARED_STORE_REL,
  legacySharedStorePath,
  resolveSharedStorePath,
  sharedStorePath as sharedStorePathForRoot,
} from "@reddb-io/shared/red-paths.js";
import {
  ResidentRspClient,
  resolveResidentPaths,
} from "@reddb-io/shared/resident-client.js";
import type { BrainResidentAction, RspResidentConfig } from "@reddb-io/shared/resident-protocol.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import type { KpiQueryInput, KpiResult } from "./kpi-query.js";
import type { ModelTierBanditDocument } from "./model-tier-bandit.js";
import type {
  BrainStoreLike,
  BrainThinkResult,
  CaptureInput,
  SearchHit,
  SearchOptions,
  ThinkOptions,
} from "./store.js";
import type { StoredBrainArtifact, StoredBrainConnection } from "./schema.js";
import type { ResolvedBrainConfig } from "./config.js";

/** Canonical shared RedDB store location (state tier); see {@link SHARED_STORE_REL}. */
export const SHARED_RSP_STORE_PATH = SHARED_STORE_REL;
const DEFAULT_RSP_TTL_DAYS = 7;
const DEFAULT_RSP_BYTE_BUDGET = 64 * 1024 * 1024;

export function shouldUseResidentBrain(config: ResolvedBrainConfig): boolean {
  if (!config.connectionString.startsWith("file://")) return false;
  const path = config.connectionString.slice("file://".length);
  // Accept both the canonical state-tier path and the legacy tmp-tier path so a
  // connection string pointed at either shares the resident during the transition.
  return path === sharedStorePathForRoot(config.rootDir) || path === legacySharedStorePath(config.rootDir);
}

export async function openResidentBrainStore(config: ResolvedBrainConfig): Promise<BrainStoreLike> {
  const paths = resolveResidentPaths(config.rootDir);
  const client = new ResidentRspClient(paths, residentConfig(config.rootDir));
  await client.request({ op: "ping" });
  return new ResidentBrainStore(client);
}

export function sharedStoreUri(rootDir: string): string {
  // Honor the transition window: open the legacy tmp-tier store if it still
  // exists and setup has not yet migrated it to the state tier.
  return `file://${resolveSharedStorePath(resolve(rootDir), existsSync)}`;
}

function residentConfig(rootDir: string): RspResidentConfig {
  return {
    storeUri: sharedStoreUri(rootDir),
    ttlDays: DEFAULT_RSP_TTL_DAYS,
    byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    serverCommand: process.env.RSP_BIN ?? "rsp",
  };
}

class ResidentBrainStore implements BrainStoreLike {
  constructor(private readonly client: ResidentRspClient) {}

  async close(): Promise<void> {}

  async status(): Promise<Record<string, unknown>> {
    const value = await this.request("status");
    return isRecord(value) ? value : {};
  }

  async capture(input: CaptureInput): Promise<StoredBrainArtifact> {
    return await this.request("capture", input) as StoredBrainArtifact;
  }

  async getArtifact(ridOrId: number | string): Promise<StoredBrainArtifact | null> {
    return await this.request("getArtifact", { ridOrId }) as StoredBrainArtifact | null;
  }

  async listArtifacts(): Promise<StoredBrainArtifact[]> {
    return await this.request("listArtifacts") as StoredBrainArtifact[];
  }

  async search(query: string, limit = 10, options: SearchOptions = {}): Promise<SearchHit[]> {
    return await this.request("search", { query, limit, options: serializableSearchOptions(options) }) as SearchHit[];
  }

  async think(query: string, limit = 8, options: ThinkOptions = {}): Promise<BrainThinkResult> {
    return await this.request("think", { query, limit, options: serializableSearchOptions(options) }) as BrainThinkResult;
  }

  async link(input: {
    from: number | string;
    to: number | string;
    kind?: string;
    reason?: string;
    confidence?: "explicit" | "derived" | "inferred";
    metadata?: Record<string, unknown>;
  }): Promise<StoredBrainConnection> {
    return await this.request("link", input) as StoredBrainConnection;
  }

  async backlinks(target: number | string): Promise<StoredBrainConnection[]> {
    return await this.request("backlinks", { target }) as StoredBrainConnection[];
  }

  async listConnections(): Promise<StoredBrainConnection[]> {
    return await this.request("listConnections") as StoredBrainConnection[];
  }

  async eventKpis(input: KpiQueryInput = {}): Promise<KpiResult> {
    return await this.request("eventKpis", input) as KpiResult;
  }

  async appendOutcomeEvent(event: OutcomeEvent): Promise<OutcomeEvent> {
    return await this.request("appendOutcomeEvent", event) as OutcomeEvent;
  }

  async replayOutcomeEvents(): Promise<OutcomeEvent[]> {
    return await this.request("replayOutcomeEvents") as OutcomeEvent[];
  }

  async loadModelTierBanditDocument(): Promise<ModelTierBanditDocument | null> {
    return await this.request("loadModelTierBanditDocument") as ModelTierBanditDocument | null;
  }

  async saveModelTierBanditDocument(document: ModelTierBanditDocument): Promise<ModelTierBanditDocument> {
    return await this.request("saveModelTierBanditDocument", document) as ModelTierBanditDocument;
  }

  async refreshModelTierBanditDocument(): Promise<ModelTierBanditDocument> {
    return await this.request("refreshModelTierBanditDocument") as ModelTierBanditDocument;
  }

  private async request(action: BrainResidentAction, payload?: unknown): Promise<unknown> {
    return await this.client.request({ op: "brain", action, payload });
  }
}

function serializableSearchOptions(options: SearchOptions): Record<string, unknown> {
  return {
    ...options,
    excludeRids: options.excludeRids ? [...options.excludeRids] : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
