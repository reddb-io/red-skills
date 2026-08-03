// Every payload read that renders a Worker asks for its display (#3144).
//
// The daemon serves three extras — `logs`, `vitals`, `display` — and withholds
// any a request does not name. The comment in the daemon says it plainly: a
// request that names NO extras "asked for everything by saying nothing". Ours
// named two, and by naming them excluded the third.
//
// So the display record was built by the castle bridge, published on the beat,
// accepted by the daemon and stored — and never requested. Every surface
// rendered a UUID and an age.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REDSKILLED_STATUSLINE_EXTRAS } from "../src/statusline-payload.js";

const CLIENT = readFileSync(join(import.meta.dirname, "..", "src", "client.ts"), "utf8");

/** Each `readRedskilledStatuslinePayload(...)` call and the extras it names. */
function payloadReads(source: string): readonly string[] {
  const out: string[] = [];
  const marker = "readRedskilledStatuslinePayload(";
  let at = source.indexOf(marker);
  while (at !== -1) {
    // The call's argument list, up to the matching close — enough to see which
    // extras it named without parsing TypeScript.
    out.push(source.slice(at, source.indexOf(");", at)));
    at = source.indexOf(marker, at + marker.length);
  }
  // The first hit is the function's own declaration, not a call.
  return out.slice(1);
}

describe("the display is asked for", () => {
  it("knows all three extras exist", () => {
    expect([...REDSKILLED_STATUSLINE_EXTRAS].sort()).toEqual(["display", "logs", "vitals"]);
  });

  it("every render read names display", () => {
    const reads = payloadReads(CLIENT);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read, `a payload read that renders a Worker must ask for its display:\n${read}`)
        .toContain("display: true");
    }
  });

  it("every render read also names vitals, so memory is never a blank", () => {
    for (const read of payloadReads(CLIENT)) expect(read).toContain("vitals: true");
  });
});
