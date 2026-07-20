/**
 * capture-store.ts — the seam between wait capture and the elision store.
 *
 * Capture must not know how the store is opened, configured, or closed; it only
 * needs "give these bytes a recoverable handle". Expressing that as a port keeps
 * the store-unavailable path testable without a real store, and keeps the
 * concrete `RspElisionStore` construction in exactly one place.
 */
import { resolveRspConfig } from "../config.js";
import { RspElisionStore, type RspLossLevel } from "../elision-store.js";

/** What capture needs from a store — nothing more. */
export interface WaitCaptureStore {
  /**
   * Persist `bytes` verbatim and return the `el:<id>` handle that recovers them.
   * Throws when the store is unavailable; capture treats that as "keep the
   * spool file" rather than as byte loss.
   */
  mint(bytes: Buffer, meta: { command: string; loss: { level: RspLossLevel; bytes_elided: number } }): Promise<string>;
}

/**
 * The real adapter: opens the configured store for one mint and closes it again.
 * A wait is a long-lived, mostly idle process, so holding the store open for the
 * whole wait would pin the handle for an hour to write once at the end.
 */
export function defaultWaitCaptureStore(cwd: string, env: NodeJS.ProcessEnv = process.env): WaitCaptureStore {
  return {
    async mint(bytes, meta) {
      const config = resolveRspConfig(cwd, env);
      const store = await RspElisionStore.open({
        uri: config.storeUri,
        ttlDays: config.ttlDays,
        ephemeralTtlHours: config.ephemeralTtlHours,
        byteBudget: config.byteBudget,
      });
      try {
        return await store.mint(bytes, meta);
      } finally {
        await store.close();
      }
    },
  };
}
