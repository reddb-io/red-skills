import { RSP_ELISION_COLLECTION, type RspExpiredHandle, type RspLossMeta, type RspStorageClass } from "./public.js";

export interface StoredRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original?: string;
  original_encoding?: "base64";
  original_bytes: number;
  content_hash?: string;
  stored_bytes?: number;
  blob_key?: string;
  command: string;
  created_at: string;
  expires_at: string;
  loss: RspLossMeta;
  storage_class?: RspStorageClass;
  derivation_recipe?: RspDerivationRecipe;
  reexecution_recipe?: RspReexecutionRecipe;
}

export interface IndexEntry {
  handle: `el:${string}`;
  key: string;
  bytes: number;
  raw_bytes?: number;
  command: string;
  created_at: string;
  expires_at: string;
  storage_class?: RspStorageClass;
  blob_key?: string;
}

export interface StoredBlob {
  key: string;
  content_hash: string;
  encoding: "gzip+base64";
  bytes: string;
  original_bytes: number;
  stored_bytes: number;
  created_at: string;
}

export interface RspDerivationRecipe {
  kind: "git-blob";
  command: string;
  cwd: string;
  object_ids: string[];
  working_tree_fingerprint: string;
  original_bytes: number;
}

export interface RspReexecutionRecipe {
  kind: "command";
  command: string;
  cwd: string;
  argv: string[];
  original_bytes: number;
  content_hash: string;
}

export interface IndexDocument {
  version: 1;
  records: IndexEntry[];
}

export interface StoreDocument {
  version: 1;
  records: Record<string, StoredRecord>;
  blobs: Record<string, StoredBlob>;
  tombstones: Record<string, RspExpiredHandle>;
  index: IndexDocument;
}

export interface RedDbKvCollectionSnapshot {
  name: string;
  items: Array<{ key: string; value: unknown }>;
}

export interface ResidentRecallHit {
  id: string;
  rid: number;
  label: string;
  node_type: string;
  score: number;
  excerpt: string;
}
