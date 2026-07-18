import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_EPHEMERAL_TTL_HOURS, DEFAULT_RSP_TTL_DAYS } from "../config.js";

export const RSP_ELISION_COLLECTION = "rsp_elisions_v1";

export { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_EPHEMERAL_TTL_HOURS, DEFAULT_RSP_TTL_DAYS };

export type RspLossLevel = "lossless" | "brief" | "terse" | (string & {});

export interface RspLossMeta {
  level: RspLossLevel;
  bytes_elided: number;
}

export interface RspMintMeta {
  command: string;
  loss: RspLossMeta;
}

export type RspStorageClass = "derivable" | "re-executable" | "ephemeral";

export type RspStorageClassStats = Record<RspStorageClass, { records: number; bytes: number; raw_bytes: number }>;

export interface RspElisionRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original: Buffer;
  command: string;
  created_at: string;
  loss: RspLossMeta;
  storage_class: RspStorageClass;
}

export interface RspExpiredHandle {
  status: "expired";
  expired_at: string;
  command: string;
  original?: undefined;
}

export interface RspStoreStats {
  records: number;
  bytes: number;
  oldest: string | null;
  budget: number;
  storage_classes: RspStorageClassStats;
}

export interface RspRecoveryHandle {
  handle: `el:${string}`;
  command: string;
  created_at: string;
  expires_at: string;
  age_seconds: number;
  age_display: string;
  storage_class: RspStorageClass;
  recover: string;
}

export interface RspElisionStoreOptions {
  uri: string;
  ttlDays?: number;
  ephemeralTtlHours?: number;
  byteBudget?: number;
  now?: () => Date;
  allowResidentOpen?: boolean;
}
