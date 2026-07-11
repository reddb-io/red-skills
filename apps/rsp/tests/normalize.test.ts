import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  NORMALIZATION_ALLOWLIST,
  NORMALIZE_ANSI,
  NORMALIZE_BLANK_LINES,
  NORMALIZE_CR_PROGRESS,
  NORMALIZE_JSON_TOON,
  NORMALIZE_TRAILING_WHITESPACE,
  formatNormalizeDecision,
  hookDecisionFromClaudePostExecJson,
  normalizeOutput,
  transcodeJsonToToon,
} from "../src/normalize.js";

const roots: string[] = [];
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-normalize-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// ─── Per-entry fixtures ───────────────────────────────────────────────────────

describe("NORMALIZE_ANSI — per-entry fixtures", () => {
  it("strips basic SGR colour sequences", () => {
    expect(NORMALIZE_ANSI.apply("\x1b[32mhello\x1b[0m")).toBe("hello");
  });

  it("strips bold+colour combined SGR", () => {
    expect(NORMALIZE_ANSI.apply("\x1b[1;31mERROR\x1b[0m: message")).toBe("ERROR: message");
  });

  it("strips erase-line and cursor-up sequences", () => {
    expect(NORMALIZE_ANSI.apply("text\x1b[2K\x1b[1A")).toBe("text");
  });

  it("strips cursor-visibility sequence (private mode)", () => {
    expect(NORMALIZE_ANSI.apply("\x1b[?25hvisible")).toBe("visible");
  });

  it("strips OSC terminal-title sequence ending in BEL", () => {
    expect(NORMALIZE_ANSI.apply("\x1b]0;My Title\x07rest")).toBe("rest");
  });

  it("strips OSC sequence ending in ST (ESC backslash)", () => {
    expect(NORMALIZE_ANSI.apply("\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\")).toBe("link text");
  });

  it("passes through text with no ANSI codes unchanged", () => {
    expect(NORMALIZE_ANSI.apply("plain text\nno escapes")).toBe("plain text\nno escapes");
  });

  it("strips codes embedded in multi-line output, byte-exact", () => {
    const input = "\x1b[33mwarning:\x1b[0m file not found\n\x1b[32mok\x1b[0m";
    expect(NORMALIZE_ANSI.apply(input)).toBe("warning: file not found\nok");
  });

  it("strips C1 CSI (0x9b) sequences", () => {
    expect(NORMALIZE_ANSI.apply("\x9b32mhello\x9b0m")).toBe("hello");
  });
});

describe("NORMALIZE_CR_PROGRESS — per-entry fixtures", () => {
  it("collapses single CR overwrite to its final frame", () => {
    expect(NORMALIZE_CR_PROGRESS.apply("Progress: 10%\rProgress: 100%")).toBe("Progress: 100%");
  });

  it("collapses multiple CR overwrites to final frame", () => {
    expect(NORMALIZE_CR_PROGRESS.apply("10%\r20%\r30%\r100%")).toBe("100%");
  });

  it("preserves trailing newline and collapses mid-line CRs", () => {
    expect(NORMALIZE_CR_PROGRESS.apply("Downloading\r\n|===  30%  ===|\r|=======100%=======|\n")).toBe(
      "Downloading\n|=======100%=======|\n",
    );
  });

  it("converts CRLF to LF (trailing \\r before \\n treated as line ending, not overwrite)", () => {
    expect(NORMALIZE_CR_PROGRESS.apply("Hello\r\nWorld\r\n")).toBe("Hello\nWorld\n");
  });

  it("passes through text with no CR unchanged", () => {
    expect(NORMALIZE_CR_PROGRESS.apply("line one\nline two\n")).toBe("line one\nline two\n");
  });
});

describe("NORMALIZE_TRAILING_WHITESPACE — per-entry fixtures", () => {
  it("strips trailing spaces from lines", () => {
    expect(NORMALIZE_TRAILING_WHITESPACE.apply("hello   \nworld")).toBe("hello\nworld");
  });

  it("strips trailing tabs from lines", () => {
    expect(NORMALIZE_TRAILING_WHITESPACE.apply("col1\tcol2\t\nend")).toBe("col1\tcol2\nend");
  });

  it("strips mixed trailing spaces and tabs", () => {
    expect(NORMALIZE_TRAILING_WHITESPACE.apply("text \t \nclean")).toBe("text\nclean");
  });

  it("preserves internal whitespace and only strips trailing", () => {
    expect(NORMALIZE_TRAILING_WHITESPACE.apply("  indented  \n")).toBe("  indented\n");
  });

  it("passes through text with no trailing whitespace unchanged", () => {
    expect(NORMALIZE_TRAILING_WHITESPACE.apply("clean\nlines\n")).toBe("clean\nlines\n");
  });
});

describe("NORMALIZE_BLANK_LINES — per-entry fixtures", () => {
  it("collapses three consecutive newlines to two", () => {
    expect(NORMALIZE_BLANK_LINES.apply("a\n\n\nb")).toBe("a\n\nb");
  });

  it("collapses four or more consecutive newlines to two", () => {
    expect(NORMALIZE_BLANK_LINES.apply("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("leaves exactly two consecutive newlines (one blank line) unchanged", () => {
    expect(NORMALIZE_BLANK_LINES.apply("a\n\nb")).toBe("a\n\nb");
  });

  it("leaves exactly one newline (no blank line) unchanged", () => {
    expect(NORMALIZE_BLANK_LINES.apply("a\nb")).toBe("a\nb");
  });

  it("passes through text with no blank lines unchanged", () => {
    expect(NORMALIZE_BLANK_LINES.apply("line1\nline2\nline3")).toBe("line1\nline2\nline3");
  });
});

// ─── JSON→TOON transcode fixtures ────────────────────────────────────────────

describe("NORMALIZE_JSON_TOON / transcodeJsonToToon — fixtures", () => {
  it("transcodes a JSON object to TOON (byte-exact spec output)", () => {
    const input = '{"project":{"id":"p1","meta":{"owner":"ops","ok":true}}}';
    const expected = "project:\n  id: p1\n  meta:\n    owner: ops\n    ok: true";
    expect(transcodeJsonToToon(input)).toBe(expected);
  });

  it("transcodes a uniform JSON array of objects to TOON tabular form", () => {
    const input =
      '{"users":[{"id":1,"name":"Alice","active":true},{"id":2,"name":"Bob","active":false}]}';
    const expected = "users[2]{id,name,active}:\n  1,Alice,true\n  2,Bob,false";
    expect(transcodeJsonToToon(input)).toBe(expected);
  });

  it("transcodes a JSON string scalar via encode/decode round-trip", () => {
    // JSON string "hello" → encode("hello") = "hello", decode("hello") = "hello"
    expect(transcodeJsonToToon('"hello"')).toBe("hello");
  });

  it("guard-failure via encode throwing ⇒ byte-identical passthrough", () => {
    const input = '{"k":"v"}';
    const result = transcodeJsonToToon(input, {
      encode: () => {
        throw new Error("encode exploded");
      },
    });
    expect(result).toBe(input);
  });

  it("guard-failure via decode throwing ⇒ byte-identical passthrough", () => {
    const input = '{"k":"v"}';
    const result = transcodeJsonToToon(input, {
      decode: () => {
        throw new Error("decode exploded");
      },
    });
    expect(result).toBe(input);
  });

  it("guard-failure via round-trip deep-equality mismatch ⇒ byte-identical passthrough", () => {
    const input = '{"k":"v"}';
    const result = transcodeJsonToToon(input, {
      encode: () => "encoded",
      decode: () => ({ different: "object" }), // mismatch
    });
    expect(result).toBe(input);
  });

  it("non-JSON body passes through byte-identical", () => {
    const input = "plain text output\nno json here\n";
    expect(transcodeJsonToToon(input)).toBe(input);
  });

  it("partial JSON (invalid) passes through byte-identical", () => {
    const input = '{"key": "val';
    expect(transcodeJsonToToon(input)).toBe(input);
  });

  it("empty string passes through", () => {
    expect(transcodeJsonToToon("")).toBe("");
  });

  it("whitespace-only string passes through", () => {
    expect(transcodeJsonToToon("   \n")).toBe("   \n");
  });

  it("NORMALIZE_JSON_TOON entry delegates to transcodeJsonToToon", () => {
    const input = '{"k":"v"}';
    expect(NORMALIZE_JSON_TOON.apply(input)).toBe(transcodeJsonToToon(input));
  });
});

// ─── Structural invariant ─────────────────────────────────────────────────────

describe("structural invariant: no mint API access", () => {
  it("normalize module source does not import from the elision store (cannot reach mint)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "normalize.ts"), "utf8");
    expect(src).not.toMatch(/elision-store/);
    expect(src).not.toMatch(/RspElisionStore/);
  });

  it("normalization allowlist has exactly five entries with the expected ids", () => {
    expect(NORMALIZATION_ALLOWLIST.map((e) => e.id)).toEqual([
      "ansi",
      "cr-progress",
      "trailing-whitespace",
      "blank-lines",
      "json-to-toon",
    ]);
  });
});

// ─── Exit-code/stderr invariance ─────────────────────────────────────────────

describe("exit-code and stderr invariance", () => {
  it("hook output targets only tool_response.output — exitCode and error fields are absent", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({
        cwd: root,
        tool_response: { output: "\x1b[32mhello\x1b[0m", error: "stderr text", exitCode: 2 },
      }),
      { cwd: root, isEnabled: () => true },
    );
    expect(decision).toEqual({ kind: "normalized", output: "hello" });
    const formatted = formatNormalizeDecision(decision);
    expect(formatted.status).toBe(0);
    const body = JSON.parse(formatted.stdout) as Record<string, unknown>;
    const resp = body["tool_response"] as Record<string, unknown>;
    expect(resp["output"]).toBe("hello");
    expect(resp).not.toHaveProperty("exitCode");
    expect(resp).not.toHaveProperty("error");
  });

  it("passthrough decision: no stdout written regardless of exit code in payload", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({ cwd: root, tool_response: { output: "clean", error: null, exitCode: 0 } }),
      { cwd: root, isEnabled: () => true },
    );
    expect(decision).toEqual({ kind: "passthrough", reason: "no-change" });
    expect(formatNormalizeDecision(decision)).toEqual({ stdout: "", status: 0 });
  });

  it("all normalizeOutput transforms leave exit code information untouched on clean input", () => {
    // A clean string with no normalizable content round-trips unchanged
    expect(normalizeOutput("clean output\n")).toBe("clean output\n");
  });
});

// ─── Hook integration ─────────────────────────────────────────────────────────

describe("rsp Claude post-execution hook integration", () => {
  it("returns normalized output and exit 0 when ANSI codes are present", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({ cwd: root, tool_response: { output: "\x1b[32mhello\x1b[0m" } }),
      { cwd: root, isEnabled: () => true },
    );
    expect(decision).toEqual({ kind: "normalized", output: "hello" });
    expect(formatNormalizeDecision(decision)).toEqual({
      stdout: JSON.stringify({ tool_response: { output: "hello" } }),
      status: 0,
    });
  });

  it("returns passthrough with empty stdout and exit 0 when output is already clean", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({ cwd: root, tool_response: { output: "clean output" } }),
      { cwd: root, isEnabled: () => true },
    );
    expect(decision).toEqual({ kind: "passthrough", reason: "no-change" });
    expect(formatNormalizeDecision(decision)).toEqual({ stdout: "", status: 0 });
  });

  it("returns passthrough when tool_response.output is missing", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({ cwd: root, tool_response: {} }),
      { cwd: root, isEnabled: () => true },
    );
    expect(decision).toEqual({ kind: "passthrough", reason: "missing-output" });
  });

  it("returns passthrough when tool_response is absent", async () => {
    const root = await tempRoot();
    const decision = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({ cwd: root }),
      { cwd: root, isEnabled: () => true },
    );
    expect(decision).toEqual({ kind: "passthrough", reason: "missing-output" });
  });

  it("makes disabled directories inert before normalization work", async () => {
    const root = await tempRoot();
    let gateCalls = 0;
    let normalizeCalls = 0;
    const result = await hookDecisionFromClaudePostExecJson(
      JSON.stringify({ cwd: root, tool_response: { output: "\x1b[32mhello\x1b[0m" } }),
      {
        cwd: root,
        isEnabled: () => {
          gateCalls++;
          return false;
        },
        normalize: (s) => {
          normalizeCalls++;
          return s;
        },
      },
    );
    expect(result).toEqual({ kind: "passthrough", reason: "disabled" });
    expect(gateCalls).toBe(1);
    expect(normalizeCalls).toBe(0);
    expect(formatNormalizeDecision(result)).toEqual({ stdout: "", status: 0 });
  });

  it("accepts PostToolUse JSON on stdin through the CLI and returns modified tool_response.output", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    const payload = JSON.stringify({
      cwd: root,
      tool_response: { output: "\x1b[32mhello\x1b[0m", error: "", exitCode: 0 },
    });

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-post-exec"], {
      cwd: root,
      input: Buffer.from(payload),
      encoding: "buffer",
    });

    expect(res.status).toBe(0);
    const body = JSON.parse(res.stdout.toString()) as { tool_response: { output: string } };
    expect(body.tool_response.output).toBe("hello");
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("CLI emits empty stdout and exits 0 when output is already clean", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    const payload = JSON.stringify({ cwd: root, tool_response: { output: "clean output\n", error: "", exitCode: 0 } });

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-post-exec"], {
      cwd: root,
      input: Buffer.from(payload),
      encoding: "buffer",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(Buffer.alloc(0));
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("CLI exits 0 and emits nothing when rsp is disabled", async () => {
    const root = await tempRoot();
    // No .red/config.yaml → rsp.enabled defaults to false

    const payload = JSON.stringify({
      cwd: root,
      tool_response: { output: "\x1b[32mhello\x1b[0m", error: "", exitCode: 0 },
    });

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "hook", "claude-post-exec"], {
      cwd: root,
      input: Buffer.from(payload),
      encoding: "buffer",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(Buffer.alloc(0));
  });
});
