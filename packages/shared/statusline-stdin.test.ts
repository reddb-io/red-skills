/**
 * statusline-stdin — the host payload is read, or its absence is survived.
 *
 * The defect this closes had ONE symptom: piping a Claude Code payload into the
 * producer changed nothing on the line. So the assertions run in both
 * directions — a well-formed payload must reach every block it feeds, and every
 * shape of no-payload must yield `null` rather than a partial object, a throw,
 * or a wait nobody bounded.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  STATUSLINE_STDIN_DEADLINE_MS,
  parseStatuslineStdinPayload,
  readStatuslineStdinPayload,
  type StatuslineStdinStream,
} from "./statusline-stdin.js";

/** The payload Claude Code writes, with every field the bedrock reads. */
const CLAUDE_PAYLOAD = JSON.stringify({
  model: { display_name: "Fable 5" },
  effort: { level: "high" },
  workspace: { current_dir: "/home/op/red-skills" },
  context_window: { total_input_tokens: 47_000, used_percentage: 23.7 },
  rate_limits: { five_hour: { used_percentage: 23 }, seven_day: { used_percentage: 41 } },
});

/** A stream a test drives by hand; `process.stdin` satisfies the same shape. */
function fakeStream(options: { isTTY?: boolean } = {}): StatuslineStdinStream & EventEmitter {
  const stream = new EventEmitter() as EventEmitter & StatuslineStdinStream & { isTTY?: boolean };
  stream.isTTY = options.isTTY;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  return stream;
}

describe("parseStatuslineStdinPayload reads every block the bedrock renders", () => {
  it("takes the model, effort, context, usage and directory off the payload", () => {
    expect(parseStatuslineStdinPayload(CLAUDE_PAYLOAD)).toEqual({
      claude: {
        model: "Fable 5",
        effort: "high",
        contextTokens: 47_000,
        contextPercent: 23.7,
        usage5h: 23,
        usage7d: 41,
      },
      cwd: "/home/op/red-skills",
    });
  });

  it("accepts a top-level cwd when the host states no workspace block", () => {
    expect(parseStatuslineStdinPayload('{"cwd":"/srv/repo"}')).toEqual({ claude: {}, cwd: "/srv/repo" });
  });

  it("distinguishes a host that spoke and had nothing to say from silence", () => {
    expect(parseStatuslineStdinPayload("{}")).toEqual({ claude: {} });
    expect(parseStatuslineStdinPayload("")).toBeNull();
    expect(parseStatuslineStdinPayload("   ")).toBeNull();
  });

  it("returns null rather than a half-trusted object for anything unparseable", () => {
    expect(parseStatuslineStdinPayload("not json at all")).toBeNull();
    expect(parseStatuslineStdinPayload("[1,2,3]")).toBeNull();
    expect(parseStatuslineStdinPayload('"a string"')).toBeNull();
  });

  it("ignores fields of the wrong type instead of rendering them", () => {
    const payload = parseStatuslineStdinPayload(
      '{"model":{"display_name":42},"context_window":{"total_input_tokens":"lots"}}',
    );
    expect(payload).toEqual({ claude: {} });
  });
});

describe("readStatuslineStdinPayload is bounded and absent-tolerant", () => {
  it("reads the payload a host writes and closes", async () => {
    const stream = fakeStream();
    const read = readStatuslineStdinPayload({ stream });
    stream.emit("data", CLAUDE_PAYLOAD);
    stream.emit("end");
    expect((await read)?.claude.model).toBe("Fable 5");
  });

  it("answers immediately on a TTY, where nothing is ever coming", async () => {
    const stream = fakeStream({ isTTY: true });
    expect(await readStatuslineStdinPayload({ stream, deadlineMs: 10_000 })).toBeNull();
  });

  it("gives up at the deadline rather than freezing the prompt", async () => {
    const stream = fakeStream();
    const started = Date.now();
    expect(await readStatuslineStdinPayload({ stream, deadlineMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(STATUSLINE_STDIN_DEADLINE_MS + 2_000);
  });

  it("truncates at the byte ceiling instead of buffering a redirected log", async () => {
    const stream = fakeStream();
    const read = readStatuslineStdinPayload({ stream, maxBytes: 8, deadlineMs: 5_000 });
    stream.emit("data", "0123456789abcdef");
    expect(await read).toBeNull();
  });

  it("treats a stream error as an absent payload", async () => {
    const stream = fakeStream();
    const read = readStatuslineStdinPayload({ stream, deadlineMs: 5_000 });
    stream.emit("error", new Error("EPIPE"));
    expect(await read).toBeNull();
  });
});
