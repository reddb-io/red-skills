import type { RspLossLevel, RspMintMeta } from "./elision-store.js";
import { renderStructuredBoundary } from "./structured-boundary.js";

export interface AutomaticOutputOptions {
  readonly command: string;
  readonly level: RspLossLevel;
  readonly store?: AutomaticOutputStore;
}

export interface AutomaticOutputStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

export interface AutomaticOutputResult {
  readonly stdout: Buffer;
  readonly lossy: boolean;
  readonly handle?: string;
  readonly bytesElided?: number;
}

/** Apply the agent-facing output policy after a command has completed. */
export async function renderAutomaticOutput(
  original: Buffer,
  _options: AutomaticOutputOptions,
): Promise<AutomaticOutputResult> {
  return {
    stdout: renderStructuredBoundary(original),
    lossy: false,
  };
}
