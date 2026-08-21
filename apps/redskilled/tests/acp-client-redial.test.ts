import { describe, expect, it } from "vitest";
import { createSelfHealingDial } from "../src/acp-client.js";

// #4154: the rs_dev MCP held one ACP connection for its whole life, so a
// routine daemon restart (every release install) turned every later tool call
// into "ACP connection closed" until the operator restarted the MCP process.
// The session now rides a self-healing dial; this suite pins its contract.

interface FakeHeld {
  readonly id: number;
  dead(): boolean;
  close(): void;
  kill(): void;
}

function fakeDialler(failures: number = 0) {
  let dialled = 0;
  let failuresLeft = failures;
  const held: FakeHeld[] = [];
  const dial = async (): Promise<FakeHeld> => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("daemon unreachable");
    }
    dialled += 1;
    let dead = false;
    const line: FakeHeld = {
      id: dialled,
      dead: () => dead,
      close: () => { dead = true; },
      kill: () => { dead = true; },
    };
    held.push(line);
    return line;
  };
  return { dial, held, count: () => dialled };
}

describe("the self-healing ACP dial (#4154)", () => {
  it("returns the same live connection while it lives", async () => {
    const { dial, count } = fakeDialler();
    const healing = await createSelfHealingDial(dial);
    const first = await healing.ensure();
    expect(await healing.ensure()).toBe(first);
    expect(count()).toBe(1);
  });

  it("dials a replacement when the held connection died, once for concurrent calls", async () => {
    const { dial, held, count } = fakeDialler();
    const healing = await createSelfHealingDial(dial);
    const first = await healing.ensure();
    held[0]!.kill();
    const [a, b, c] = await Promise.all([healing.ensure(), healing.ensure(), healing.ensure()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).not.toBe(first);
    expect(count()).toBe(2);
  });

  it("re-dials after a failed replacement instead of caching the failure", async () => {
    const { dial, held } = fakeDialler();
    let failNext = false;
    const healing = await createSelfHealingDial(async () => {
      if (failNext) { failNext = false; throw new Error("daemon unreachable"); }
      return await dial();
    });
    held[0]!.kill();
    failNext = true;
    await expect(healing.ensure()).rejects.toThrow("daemon unreachable");
    const replacement = await healing.ensure();
    expect(replacement.id).toBe(2);
  });

  it("refuses calls after an explicit close, and the first dial's failure reaches the caller", async () => {
    const { dial } = fakeDialler();
    const healing = await createSelfHealingDial(dial);
    healing.close();
    await expect(healing.ensure()).rejects.toThrow("closed");
    await expect(createSelfHealingDial(async () => { throw new Error("no daemon"); }))
      .rejects.toThrow("no daemon");
  });
});
