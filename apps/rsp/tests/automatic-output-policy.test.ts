import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { renderAutomaticOutput } from "../src/automatic-output-policy.js";

class MemoryStore {
  readonly originals = new Map<string, Buffer>();
  mintCalls = 0;

  async mint(original: Uint8Array | Buffer): Promise<string> {
    this.mintCalls += 1;
    this.originals.set("el:automaticfixture", Buffer.from(original));
    return "el:automaticfixture";
  }
}

describe("rsp automatic output policy", () => {
  it("keeps small structured output complete and mints no recovery handle", async () => {
    const original = Buffer.from('{"services":[{"name":"api","healthy":true},{"name":"worker","healthy":false}]}\n');
    const store = new MemoryStore();

    const result = await renderAutomaticOutput(original, {
      command: "service-status --json",
      level: "lossless",
      store,
    });

    expect(result.lossy).toBe(false);
    expect(result.handle).toBeUndefined();
    expect(store.mintCalls).toBe(0);
    expect(decode(result.stdout.toString("utf8"))).toEqual({
      services: [
        { name: "api", healthy: true },
        { name: "worker", healthy: false },
      ],
    });
  });
});
