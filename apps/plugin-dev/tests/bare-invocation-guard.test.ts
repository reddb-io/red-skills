import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_INVOCATION_PREFIX,
  DOC_SWEEP_ROOTS,
  EXECUTION_CHAIN_ENTRYPOINTS,
  SHIPPED_BINARIES,
  describeBareInvocations,
  describeRetiredInstructions,
  findBareInvocations,
  findRetiredInstructions,
  instructableEntrypoints,
  scanRetiredInstructions,
  scanSweptDocuments,
  sweptDocuments,
} from "../src/core/bare-invocation-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

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
      ["```bash", `printf '%s\\n' "$root" | red-skills-redskilled host-state --stdin`, "```"].join("\n"),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ binary: "red-skills-redskilled", kind: "fenced" });
  });

  it("accepts the canonical npx form", () => {
    const canonical = [
      "```bash",
      `${CANONICAL_INVOCATION_PREFIX}<version> red-skills-redskilled provision --install-unit`,
      "```",
      "",
      `Or inline: \`${CANONICAL_INVOCATION_PREFIX}<version> red-skills-redskilled host-state\`.`,
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
      "pnpm -C apps/plugin-dev test",
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

  it("runs in every gate run — the swept surfaces span the whole repo", () => {
    const names = REPO_INVARIANT_SUITES.map((suite) => suite.name);

    expect(names).toContain("invariants:bare-invocations");
  });

  it("no swept surface offers a bare shipped-binary command", () => {
    const sites = scanSweptDocuments(REPO_ROOT, DOC_SWEEP_ROOTS);

    expect(sites, describeBareInvocations(sites)).toEqual([]);
  });
});

describe("retired execution-chain entrypoints (ADR 0147 rule 1, #4030)", () => {
  it("leaves the daemon as the only instructable binary of the chain", () => {
    expect(instructableEntrypoints()).toEqual(["redskilled", "red-skills-redskilled"]);
  });

  it("names the route that replaces each retired entrypoint", () => {
    for (const entry of EXECUTION_CHAIN_ENTRYPOINTS.filter((candidate) => !candidate.instructable)) {
      expect(entry.replacement.length, `\`${entry.token}\` names its replacement`).toBeGreaterThan(20);
    }
  });

  it("refuses the retired CLI even behind the canonical prefix", () => {
    const sites = findRetiredInstructions(
      "fixture.md",
      ["```bash", `${CANONICAL_INVOCATION_PREFIX}<version> red-skills-dev dashboard --json`, "```"].join("\n"),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ kind: "fenced", entrypoint: { token: "red-skills-dev" } });
    expect(describeRetiredInstructions(sites)).toContain("rs_dev");
  });

  it("refuses the forwarder and the bundle it reaches, at any path", () => {
    const sites = findRetiredInstructions(
      "fixture.md",
      [
        "```bash",
        "node plugins/dev/skills/engineering/afk/bin/afk.mjs dashboard",
        "node dist/dev.bundle.min.mjs run --once",
        "```",
      ].join("\n"),
    );

    expect(sites.map((site) => site.entrypoint.token)).toEqual(["afk.mjs", ".bundle.min.mjs"]);
  });

  it("refuses a retired command in an inline prose span", () => {
    const sites = findRetiredInstructions("fixture.md", "Fall back to `red-skills-dev retake 123`.");

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ kind: "inline" });
  });

  it("accepts the retired NAME with nothing after it — a name is not an instruction", () => {
    const prose = [
      "Install the plugin package `@reddb-io/red-skills-dev`.",
      "Check the shim with `command -v red-skills-dev`.",
      "The bundle ships as `dist/dev.bundle.min.mjs`.",
    ].join("\n");

    expect(findRetiredInstructions("fixture.md", prose)).toEqual([]);
  });

  it("accepts the surviving daemon command", () => {
    const command = ["```bash", `${CANONICAL_INVOCATION_PREFIX}<version> red-skills-redskilled provision`, "```"].join(
      "\n",
    );

    expect(findRetiredInstructions("fixture.md", command)).toEqual([]);
  });

  it("no swept surface instructs a retired entrypoint", () => {
    const sites = scanRetiredInstructions(REPO_ROOT, DOC_SWEEP_ROOTS);

    expect(sites, describeRetiredInstructions(sites)).toEqual([]);
  });
});
