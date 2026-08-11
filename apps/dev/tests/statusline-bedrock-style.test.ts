/**
 * statusline-bedrock-style — the themed bedrock is paint, never content.
 *
 * The load-bearing claim is the strip invariant: stripping the themed render
 * recovers the plain bedrock byte for byte behind the `»` mark, for every
 * input shape. Everything else pins the paint to the shared role palette so a
 * hand-tuned tone cannot arrive under a role's name.
 */
import {
  BOLD,
  DIM,
  IDENTITY_BG,
  IDENTITY_INK,
  KEY,
  MODEL_BG,
  NOBG,
  NOBOLD,
  PAPER,
  RESET,
  SOFT,
  VAL,
} from "@reddb-io/redskilled-render/palette.js";
import { stripAnsi } from "@reddb-io/redskilled-render/format.js";
import { describe, expect, it } from "vitest";
import {
  renderStatuslineBedrock,
  type StatuslineBedrockInput,
} from "../src/core/statusline-bedrock.js";
import {
  paintLifecycleTokens,
  renderStatuslineBedrockThemed,
} from "../src/core/statusline-bedrock-style.js";

const FULL: StatuslineBedrockInput = {
  project: { basename: "red-skills", branch: "afk/3563-bedrock", version: "3.12.13" },
  claude: {
    model: "Opus",
    effort: "high",
    contextTokens: 47_000,
    contextPercent: 24,
    usage5h: 23,
    usage7d: 41,
  },
  localDiff: { localAdded: 142, localRemoved: 36 },
};

describe("the themed bedrock is the plain bedrock behind the » mark", () => {
  it.each<[string, StatuslineBedrockInput]>([
    ["full", FULL],
    ["project-only", { project: { basename: "red-skills" } }],
    ["detached, no diff", {
      project: { basename: "red-skills", detachedSha: "7658ad2", version: "3.12.13" },
      claude: { model: "Opus" },
      localDiff: {},
    }],
    ["context without usage", {
      project: { basename: "red-skills", branch: "main", version: "3.13.0" },
      claude: { model: "Fable 5", effort: "high", contextTokens: 569_000, contextPercent: 57 },
      localDiff: { localAdded: 2 },
    }],
  ])("strips back to the plain render (%s)", (_name, input) => {
    expect(stripAnsi(renderStatuslineBedrockThemed(input))).toBe(
      `» ${renderStatuslineBedrock(input)}`,
    );
  });

  it("closes itself, so a bedrock alone on the line bleeds nothing", () => {
    expect(renderStatuslineBedrockThemed(FULL).endsWith(RESET)).toBe(true);
  });

  it("paints the brand field, the receded model field, and the kv tail in their roles", () => {
    const line = renderStatuslineBedrockThemed(FULL);

    expect(line).toContain(
      `${IDENTITY_BG}${IDENTITY_INK}» ${BOLD}red-skills${NOBOLD} (afk/3563-bedrock) v3.12.13${NOBG}`,
    );
    expect(line).toContain(`${MODEL_BG}${PAPER}Opus·high${NOBG}`);
    expect(line).toContain(`${KEY}ctx=${VAL}47k 24%`);
    expect(line).toContain(`${KEY}5h=${VAL}23%`);
    expect(line).toContain(`${KEY}7d=${VAL}41%`);
    expect(line).toContain(`${KEY}loc=${VAL}+142`);
  });
});

describe("paintLifecycleTokens paints the lifecycle's plain shapes and nothing else", () => {
  it("paints a whole-line state token in the kv convention, value dimmed", () => {
    const painted = paintLifecycleTokens("rsk=bedrock-only");

    expect(stripAnsi(painted)).toBe("rsk=bedrock-only");
    expect(painted).toContain(`${KEY}rsk=${DIM}bedrock-only`);
    expect(painted.endsWith(RESET)).toBe(true);
  });

  it("paints the age and state suffix on a cached head, leaving the head alone", () => {
    const head = `${SOFT}w1 iss=42${RESET}`;
    const painted = paintLifecycleTokens(`${head} · age=3m · rsk=degraded`);

    expect(stripAnsi(painted)).toBe("w1 iss=42 · age=3m · rsk=degraded");
    expect(painted.startsWith(head)).toBe(true);
    expect(painted).toContain(`${KEY}age=${DIM}3m`);
    expect(painted).toContain(`${KEY}rsk=${DIM}degraded`);
    expect(painted.endsWith(RESET)).toBe(true);
  });

  it("passes a painted daemon row through untouched", () => {
    const row = `${SOFT}w1 run=claude ${KEY}iss=${VAL}42${SOFT}${RESET}`;

    expect(paintLifecycleTokens(row)).toBe(row);
  });
});
