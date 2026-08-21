/**
 * statusline-bedrock-host — the daemon command renders BOTH halves of the line.
 *
 * The defect: ADR 0147 deleted the dev bundle that owned the Statusline Bedrock,
 * PR #4272 pointed the host's `statusLine.command` at the `redskilled` bundle,
 * and that bundle rendered the tail alone — so the operator's bar lost model,
 * branch and context, and piping a Claude Code payload into it changed nothing.
 *
 * These tests are written against the symptom: a fixed stdin payload must reach
 * the line, an absent or malformed one must cost the bedrock's payload blocks
 * and nothing else, and the composition must always be bedrock-then-tail.
 */
import { describe, expect, it, vi } from "vitest";
import {
  collectStatuslineBedrockInput,
  composeStatuslineWithBedrock,
  renderStatuslineBedrockLine,
  type StatuslineBedrockIO,
} from "../src/statusline-bedrock-host.js";

const ESC = String.fromCharCode(27);

const CLAUDE_PAYLOAD = {
  claude: {
    model: "Fable 5",
    effort: "high",
    contextTokens: 47_000,
    contextPercent: 24,
  },
  cwd: "/home/op/red-skills",
};

const LOCAL_GIT = {
  basename: "red-skills",
  branch: "fix/statusline-bedrock-in-daemon",
  localAdded: 119,
  localRemoved: 12,
};

/** The bedrock this fixture renders, branch truncated by the 28-char rule. */
const BEDROCK = "red-skills (fix/statusline-bedrock-in-d…) v4.1.22"
  + " Fable 5·high ctx=47k 24% loc=+119 -12";

function io(overrides: Partial<StatuslineBedrockIO> = {}): StatuslineBedrockIO {
  return {
    readStdin: async () => CLAUDE_PAYLOAD,
    readLocalGit: async () => LOCAL_GIT,
    version: "4.1.22",
    env: { NO_COLOR: "1" },
    ...overrides,
  };
}

describe("the bedrock renders from the Claude Code stdin payload", () => {
  it("puts the model, the branch, the context and the version on the line", async () => {
    const line = renderStatuslineBedrockLine(await collectStatuslineBedrockInput(io()), {
      NO_COLOR: "1",
    });
    expect(line).toBe(BEDROCK);
  });

  it("reads git from the directory the SESSION states, not the process's own", async () => {
    const readLocalGit = vi.fn(async () => LOCAL_GIT);
    await collectStatuslineBedrockInput(io({ readLocalGit, cwd: "/somewhere/else" }));
    expect(readLocalGit).toHaveBeenCalledWith("/home/op/red-skills");
  });

  it("falls back to the process directory when the payload names none", async () => {
    const readLocalGit = vi.fn(async () => LOCAL_GIT);
    await collectStatuslineBedrockInput(
      io({ readStdin: async () => null, readLocalGit, cwd: "/somewhere/else" }),
    );
    expect(readLocalGit).toHaveBeenCalledWith("/somewhere/else");
  });

  it("renders a detached head as a sha when there is no branch", async () => {
    const input = await collectStatuslineBedrockInput(
      io({
        readLocalGit: async () => ({
          basename: "red-skills",
          detachedSha: "abc1234",
          localAdded: 0,
          localRemoved: 0,
        }),
      }),
    );
    expect(renderStatuslineBedrockLine(input, { NO_COLOR: "1" })).toBe(
      "red-skills (detached abc1234) v4.1.22 Fable 5·high ctx=47k 24%",
    );
  });

  it("paints unless the operator said NO_COLOR — a pipe is not a mute button", async () => {
    const input = await collectStatuslineBedrockInput(io());
    expect(renderStatuslineBedrockLine(input, {})).toContain(ESC);
    expect(renderStatuslineBedrockLine(input, { NO_COLOR: "1" })).not.toContain(ESC);
  });
});

describe("an absent or malformed payload costs the payload blocks and nothing else", () => {
  it("keeps the project, branch and version when no host wrote to stdin", async () => {
    const input = await collectStatuslineBedrockInput(io({ readStdin: async () => null }));
    expect(renderStatuslineBedrockLine(input, { NO_COLOR: "1" })).toBe(
      "red-skills (fix/statusline-bedrock-in-d…) v4.1.22 loc=+119 -12",
    );
  });

  it("degrades to the tail alone when even git cannot answer", async () => {
    const lines = await composeStatuslineWithBedrock(["0w idle rdy=0 iss=2"], {
      ...io({ readStdin: async () => null }),
      readLocalGit: async () => ({ basename: "", localAdded: 0, localRemoved: 0 }),
    });
    expect(lines).toEqual([" v4.1.22 · 0w idle rdy=0 iss=2"]);
  });
});

describe("the composed line is bedrock, then the daemon tail", () => {
  it("leads the header with the bedrock and keeps every Worker row after it", async () => {
    const tail = "0w idle rdy=0 iss=2 pr=0 mrg=53 0B v4.1.22";
    const lines = await composeStatuslineWithBedrock([tail, "worker row"], io());
    expect(lines).toEqual([`${BEDROCK} · ${tail}`, "worker row"]);
    expect(lines[0]).toMatch(/^red-skills .*rdy=0 iss=2/);
  });

  it("stands alone when the daemon produced no tail at all", async () => {
    expect(await composeStatuslineWithBedrock([], io())).toEqual([BEDROCK]);
  });
});
