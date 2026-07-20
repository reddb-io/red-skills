/**
 * capture.ts — bounded, byte-exact capture of a waited command's output.
 *
 * A wait may front a command that prints a gigabyte, so capture must never grow
 * with the output. {@link BoundedStreamCapture} keeps at most `limit` bytes
 * resident: the inline head. Everything beyond the head streams straight to a
 * spool file in the waits lane and is handed to the elision store at the end,
 * so the summary stays small while the ORIGINAL bytes remain recoverable.
 *
 * Two rules the rest of the module leans on:
 *
 * - **Handle iff elided.** If any byte was withheld from `inline`, the capture
 *   carries an `el:<id>` handle (or, if the store refused, the spool path that
 *   still holds those bytes). Truncation is never silent.
 * - **Bytes survive an unavailable store.** A failed mint keeps the spool file
 *   and reports it. Losing the store costs recoverability through `rsp show`,
 *   never the bytes themselves.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import type { WaitCaptureStore } from "./capture-store.js";

/** How the inline head is encoded — base64 only when the bytes are not text. */
export type InlineEncoding = "utf8" | "base64";

export interface CaptureResult {
  /** Exact byte count of the whole stream, elided part included. */
  bytes: number;
  /** The head of the stream, at most `limit` bytes. */
  inline: string;
  /** Present only when `inline` is not plain UTF-8 text. */
  inline_encoding?: InlineEncoding;
  /** True iff bytes were withheld from `inline`. */
  truncated: boolean;
  /** Recovery handle; present iff `truncated` and the store accepted the bytes. */
  handle?: string;
  /** Why the handle is missing — set only when a mint failed. */
  recovery_error?: string;
  /** Where the full bytes still live when the store could not take them. */
  spool_path?: string;
}

/**
 * A streaming sink with a fixed memory ceiling.
 *
 * The spool only opens once the stream actually exceeds `limit`; a command whose
 * output fits inline never touches the disk.
 */
export class BoundedStreamCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private total = 0;
  private spool: WriteStream | null = null;
  private spoolReady: Promise<void> = Promise.resolve();
  private spoolError: string | null = null;
  private closed = false;

  constructor(
    private readonly limit: number,
    private readonly spoolPath: string,
  ) {}

  /** Absorb one chunk. Resident memory after this call is still <= `limit`. */
  write(chunk: Buffer): void {
    if (this.closed) return;
    this.total += chunk.length;
    const headRoom = this.limit - this.headBytes;
    if (headRoom > 0) {
      const slice = chunk.subarray(0, headRoom);
      this.head.push(slice);
      this.headBytes += slice.length;
    }
    // Past the head everything must reach the spool, including the tail of the
    // chunk that straddles the boundary.
    if (this.total > this.limit) {
      const overflow = headRoom > 0 ? chunk.subarray(headRoom) : chunk;
      this.openSpool();
      if (overflow.length > 0) this.appendSpool(overflow);
    }
  }

  /**
   * Close the spool and describe the capture, minting a handle when bytes were
   * elided. `command` is what `rsp show` will print as the way to reproduce.
   */
  async finish(store: WaitCaptureStore, command: string): Promise<CaptureResult> {
    this.closed = true;
    const inlineBytes = Buffer.concat(this.head);
    const truncated = this.total > this.headBytes;
    const result: CaptureResult = {
      bytes: this.total,
      ...encodeInline(inlineBytes),
      truncated,
    };
    if (!truncated) {
      await this.discardSpool();
      return result;
    }

    await this.closeSpool();
    if (this.spoolError) {
      // The spool itself failed, so the elided bytes were never durable. Say so
      // rather than implying a handle could exist.
      result.recovery_error = this.spoolError;
      return result;
    }
    try {
      // The head is in memory and the remainder on disk; rejoin them so the
      // handle recovers the stream exactly as the command produced it.
      const spooled = await readFile(this.spoolPath);
      result.handle = await store.mint(Buffer.concat([inlineBytes, spooled]), {
        command,
        loss: { level: "terse", bytes_elided: this.total - this.headBytes },
      });
      await this.discardSpool();
    } catch (err) {
      // Store unavailable: keep the spool. The bytes are still on disk, and the
      // caller is told exactly where.
      result.recovery_error = err instanceof Error ? err.message : String(err);
      result.spool_path = this.spoolPath;
    }
    return result;
  }

  /** Drop any spooled bytes — used when a wait is torn down without a result. */
  async discard(): Promise<void> {
    this.closed = true;
    await this.closeSpool();
    await this.discardSpool();
  }

  private openSpool(): void {
    if (this.spool || this.spoolError) return;
    // The lane is created only now: a wait whose output fits inline must leave
    // nothing behind in `.red/tmp/waits`.
    let stream: WriteStream;
    try {
      mkdirSync(dirname(this.spoolPath), { recursive: true });
      stream = createWriteStream(this.spoolPath, { flags: "w" });
    } catch (err) {
      this.spoolError = err instanceof Error ? err.message : String(err);
      return;
    }
    stream.on("error", (err) => {
      this.spoolError = err instanceof Error ? err.message : String(err);
    });
    this.spool = stream;
    // The head has not been written yet — the spool holds only what follows it.
  }

  private appendSpool(chunk: Buffer): void {
    const stream = this.spool;
    if (!stream) return;
    // Serialize writes behind one promise so backpressure is respected without
    // buffering the unwritten remainder in memory.
    this.spoolReady = this.spoolReady.then(
      () =>
        new Promise<void>((resolveWrite) => {
          if (!stream.write(chunk)) stream.once("drain", () => resolveWrite());
          else resolveWrite();
        }),
    );
  }

  private async closeSpool(): Promise<void> {
    const stream = this.spool;
    if (!stream) return;
    this.spool = null;
    await this.spoolReady.catch(() => undefined);
    await new Promise<void>((resolveClosed) => stream.end(() => resolveClosed()));
  }

  private async discardSpool(): Promise<void> {
    await rm(this.spoolPath, { force: true }).catch(() => undefined);
  }
}

/** Create both stream captures for one command, with their spool lane prepared. */
export function createCommandCaptures(
  spoolDir: string,
  id: string,
  limit: number,
): { stdout: BoundedStreamCapture; stderr: BoundedStreamCapture } {
  return {
    stdout: new BoundedStreamCapture(limit, join(spoolDir, `${id}.stdout.bin`)),
    stderr: new BoundedStreamCapture(limit, join(spoolDir, `${id}.stderr.bin`)),
  };
}

/**
 * Render the inline head as text when it IS text, and as labeled base64
 * otherwise.
 *
 * Two things disqualify a head from the text path. Bytes that do not survive a
 * UTF-8 round trip would simply be corrupted. Bytes that survive but are not
 * printable — NUL above all — round-trip fine yet poison the TOON/JSON envelope
 * they get embedded in, so a head carrying them is treated as binary too.
 */
function encodeInline(bytes: Buffer): { inline: string; inline_encoding?: InlineEncoding } {
  const text = bytes.toString("utf8");
  const roundTrips = Buffer.from(text, "utf8").equals(bytes);
  if (roundTrips && !hasControlBytes(bytes)) return { inline: text };
  return { inline: bytes.toString("base64"), inline_encoding: "base64" };
}

/** C0 controls other than tab, newline, and carriage return — i.e. not text. */
function hasControlBytes(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte <= 0x08 || (byte >= 0x0b && byte <= 0x1f && byte !== 0x0d) || byte === 0x7f) return true;
  }
  return false;
}
