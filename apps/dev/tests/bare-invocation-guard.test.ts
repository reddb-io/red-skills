import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_INVOCATION_PREFIX,
  DOC_SWEEP_ROOTS,
  SHIPPED_BINARIES,
  describeBareInvocations,
  findBareInvocations,
  scanSweptDocuments,
  sweptDocuments,
} from "../src/core/bare-invocation-guard.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("bare shipped-binary invocation guard (#3071)", () => {
  it("flags a bare command in a fenced shell block", () => {
    const sites = findBareInvocations(
      "fixture.md",
      ["Bring the daemon up:", "", "```bash", "redskilled provision --install-unit", "```"].join("\n"),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      line: 4,
      binary: "redskilled",
      kind: "fenced",
      command: "redskilled provision --install-unit",
    });
  });

  it("flags a bare command in an inline prose span", () => {
    const sites = findBareInvocations("fixture.md", "Run `redskilled provision` to install it.");

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ binary: "redskilled", kind: "inline" });
  });

  it("flags a bare binary downstream of a pipe", () => {
    const sites = findBareInvocations(
      "fixture.md",
      ["```bash", `printf '%s\\n' "$tracked" | red-skills-dev monitor --mirror-plan`, "```"].join("\n"),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ binary: "red-skills-dev", kind: "fenced" });
  });

  it("accepts the canonical npx form", () => {
    const canonical = [
      "```bash",
      `${CANONICAL_INVOCATION_PREFIX}<version> red-skills-redskilled provision --install-unit`,
      "```",
      "",
      `Or inline: \`${CANONICAL_INVOCATION_PREFIX}<version> red-skills-dev dashboard\`.`,
    ].join("\n");

    expect(findBareInvocations("fixture.md", canonical)).toEqual([]);
  });

  it("accepts the binary NAME on its own — prose is not a command", () => {
    const prose = [
      "The `redskilled` daemon owns every birth (ADR 0130).",
      "A `red-skills-dev` shim on PATH is a warm-cache optimization.",
    ].join("\n");

    expect(findBareInvocations("fixture.md", prose)).toEqual([]);
  });

  it("accepts an indented line inside a fence — a rendered sample is not a command", () => {
    const render = ["```", " redskilled 0.4.1 · pid 4242 · up 3h00m · proto 1", "```"].join("\n");

    expect(findBareInvocations("fixture.md", render)).toEqual([]);
  });

  it("accepts checkout-local and repo-local surfaces", () => {
    const exceptions = [
      "```bash",
      "pnpm -C apps/dev test",
      "node plugins/dev/skills/engineering/afk/bin/afk.mjs dashboard",
      "rsp git status",
      "```",
    ].join("\n");

    expect(findBareInvocations("fixture.md", exceptions)).toEqual([]);
  });

  it("matches an ordinary-word binary only inside a fence, never in prose", () => {
    const inline = findBareInvocations("fixture.md", "The `memory recall` core answers it.");
    expect(inline).toEqual([]);

    const fenced = findBareInvocations("fixture.md", ["```bash", "memory recall 'cache TTL'", "```"].join("\n"));
    expect(fenced).toHaveLength(1);
    expect(fenced[0]).toMatchObject({ binary: "memory", kind: "fenced" });
  });

  it("sweeps a real, non-empty set of doc surfaces", () => {
    const docs = sweptDocuments(REPO_ROOT, DOC_SWEEP_ROOTS);

    expect(docs).toContain("README.md");
    expect(docs).toContain("plugins/dev/skills/engineering/afk/SKILL.md");
    expect(docs).toContain("apps/redskilled/README.md");
    expect(docs.some((path) => path.endsWith("CHANGELOG.md"))).toBe(false);
  });

  it("leaves rsp out of the swept binaries — it is repo-local by design", () => {
    expect(SHIPPED_BINARIES.some((binary) => binary.name === "rsp")).toBe(false);
  });

  it("no swept surface offers a bare shipped-binary command", () => {
    const sites = scanSweptDocuments(REPO_ROOT, DOC_SWEEP_ROOTS);

    expect(sites, describeBareInvocations(sites)).toEqual([]);
  });
});
