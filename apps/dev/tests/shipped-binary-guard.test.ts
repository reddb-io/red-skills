/**
 * The shipped-binary invariant: a binary declared in a workspace `bin` map that
 * cannot answer `--version`, or that walks `process.argv` instead of routing it
 * through the shared contract, fails here (issue #2878).
 *
 * The convergence tickets fixed five offenders one by one. This suite exists for
 * the sixth: every failure mode is proved with a FIXTURE, because a suite that
 * asserts only the passing state cannot tell "the tree is clean" from "the check
 * never fires". The live-tree assertion is the ratchet; the fixtures are the proof
 * that the ratchet has teeth.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBundleEntries,
  collectDeclaredBinaries,
  collectModuleChain,
  findArgvWalks,
  findShippedBinaryViolations,
  formatShippedBinaryFailureMessage,
  isArgvRead,
  readBinaryPackageManifests,
  readBinarySourceFiles,
  resolveBinaryEntry,
  routesVersion,
  type BinaryPackageManifest,
  type BinarySourceFile,
  type DeclaredBinary,
} from "../src/core/shipped-binary-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function tree(entries: Record<string, string>): Map<string, BinarySourceFile> {
  return new Map(
    Object.entries(entries).map(([relativePath, sourceText]) => [
      relativePath,
      { relativePath, sourceText },
    ]),
  );
}

function binary(target: string, name = "demo"): DeclaredBinary {
  return { name, declaredIn: "apps/demo/package.json", target };
}

/** A converged entry: the stamp answer and the route that reaches it. */
const CONVERGED_ENTRY = `
  import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
  import { parseFlags } from "@reddb-io/shared/args.js";
  const FLAGS = { version: { kind: "boolean", aliases: ["v"] } };
  const { values } = parseFlags(process.argv.slice(2), FLAGS);
  if (values.version === true) process.stdout.write(renderVersion(readBuildInfo("demo")));
`;

describe("every shipped binary in the live tree answers --version (#2878)", () => {
  const manifests = readBinaryPackageManifests(ROOT);
  const files = readBinarySourceFiles(ROOT);
  const bundles = collectBundleEntries(manifests);
  const binaries = collectDeclaredBinaries(manifests);

  it("is green across every declared bin map", () => {
    const violations = findShippedBinaryViolations(binaries, files, bundles);

    expect(violations, formatShippedBinaryFailureMessage(violations)).toEqual([]);
  });

  it("scanned the tree — a walker that reaches nothing is green by accident", () => {
    expect(files.size).toBeGreaterThan(200);
    expect(binaries.length).toBeGreaterThanOrEqual(10);
    expect(binaries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["brain", "memory", "rsp", "red-skills-dev", "red-skills-redskilled"]),
    );
  });

  it("resolves every declared binary to a source that exists", () => {
    const unresolved = binaries
      .map((entry) => resolveBinaryEntry(entry, files, bundles))
      .filter((entry) => entry.entry === undefined);

    expect(unresolved.map((entry) => `${entry.name} -> ${entry.target}`)).toEqual([]);
  });

  it("follows a packaged shim through to the bundle's own entry", () => {
    const dev = binaries.find((entry) => entry.name === "red-skills-dev")!;

    expect(resolveBinaryEntry(dev, files, bundles).hops).toEqual([
      "packaging/npm/bin/red-skills-dev.mjs",
      "apps/dev/src/cli.ts",
    ]);
  });

  it("checks each binary against its OWN version answer, not a neighbour's", () => {
    // The whole invariant would be decorative if one `renderVersion` call
    // anywhere in a package satisfied every binary that package ships.
    const answers = new Map(
      binaries
        .map((entry) => resolveBinaryEntry(entry, files, bundles))
        .filter((entry) => entry.entry !== undefined)
        .map((entry) => [
          entry.name,
          collectModuleChain(entry.entry!, files, 2).filter((path) =>
            /\brenderVersion\s*\(/.test(files.get(path)!.sourceText),
          ),
        ]),
    );

    expect(answers.get("red-skills-dev")).toEqual(["apps/dev/src/cli.ts"]);
    expect(answers.get("red-skills-castle-mcp")).toEqual(["apps/dev/src/mcp-server.ts"]);
    expect(answers.get("memory-mcp")).toEqual(["apps/memory/src/mcp-server/runtime.ts"]);
  });
});

describe("a binary with no version surface fails, naming the binary and the file", () => {
  it("fails when nothing in the surface answers --version", () => {
    const files = tree({
      "apps/demo/src/cli.ts": `
        import { parseFlags } from "@reddb-io/shared/args.js";
        parseFlags(process.argv.slice(2), {});
      `,
    });

    const violations = findShippedBinaryViolations(
      [binary("apps/demo/dist/cli.js", "demo")],
      files,
      new Map(),
    );

    expect(violations).toEqual([
      { binary: "demo", kind: "no-version-answer", file: "apps/demo/src/cli.ts" },
    ]);
    const message = formatShippedBinaryFailureMessage(violations);
    expect(message).toContain("demo");
    expect(message).toContain("apps/demo/src/cli.ts");
    expect(message).toContain("build stamp");
  });

  it("fails when the stamp is read but no --version route reaches it", () => {
    const files = tree({
      "apps/demo/src/cli.ts": `
        import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
        function unreachable() { return renderVersion(readBuildInfo("demo")); }
        main(process.argv.slice(2));
      `,
    });

    expect(
      findShippedBinaryViolations([binary("apps/demo/dist/cli.js")], files, new Map()),
    ).toEqual([{ binary: "demo", kind: "no-version-route", file: "apps/demo/src/cli.ts" }]);
  });

  it("accepts a route declared in the flag module the answering file imports", () => {
    // code-nav's shape: the schema lives in `cli-args`, the print in the entry.
    const files = tree({
      "apps/demo/src/cli.ts": `
        import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
        import { isVersionRequest } from "./cli-args.js";
        if (isVersionRequest(process.argv.slice(2))) process.stdout.write(renderVersion(readBuildInfo("demo")));
      `,
      "apps/demo/src/cli-args.ts": `
        export const FLAGS = { version: { kind: "boolean", aliases: ["v"] } };
      `,
    });

    expect(routesVersion("apps/demo/src/cli.ts", files)).toBe(true);
    expect(findShippedBinaryViolations([binary("apps/demo/dist/cli.js")], files, new Map())).toEqual(
      [],
    );
  });

  it("does not count prose — a comment promising a version surface is not one", () => {
    const files = tree({
      "apps/demo/src/cli.ts": `
        // This binary answers --version by calling renderVersion(readBuildInfo("demo")).
        main(process.argv.slice(2));
      `,
    });

    expect(
      findShippedBinaryViolations([binary("apps/demo/dist/cli.js")], files, new Map())[0]?.kind,
    ).toBe("no-version-answer");
  });

  it("fails when the bin target resolves to nothing at all", () => {
    const violations = findShippedBinaryViolations(
      [binary("apps/demo/dist/ghost.js")],
      tree({}),
      new Map(),
    );

    // Only the resolution failure: naming a missing version surface in a file
    // that does not exist would send a human to read nothing.
    expect(violations).toEqual([
      { binary: "demo", kind: "unresolved-entry", file: "apps/demo/dist/ghost.js" },
    ]);
    expect(formatShippedBinaryFailureMessage(violations)).toContain("apps/demo/dist/ghost.js");
  });
});

describe("a binary that parses argv directly fails, naming the offending call", () => {
  it("fails on a hand-rolled argv walk in the entry", () => {
    const files = tree({
      "apps/demo/src/cli.ts": `${CONVERGED_ENTRY}\nif (process.argv.includes("--json")) emitJson();`,
    });

    const violations = findShippedBinaryViolations(
      [binary("apps/demo/dist/cli.js")],
      files,
      new Map(),
    );

    expect(violations).toEqual([
      {
        binary: "demo",
        kind: "argv-walk",
        file: "apps/demo/src/cli.ts",
        line: 8,
        evidence: 'process.argv.includes("--json")',
      },
    ]);
    expect(formatShippedBinaryFailureMessage(violations)).toContain("@reddb-io/shared/args");
  });

  it("follows the whole chain — a walk buried three modules down still fails", () => {
    const files = tree({
      "apps/demo/src/cli.ts": `${CONVERGED_ENTRY}\nimport { run } from "./run.js";`,
      "apps/demo/src/run.ts": `import { flags } from "./flags.js";`,
      "apps/demo/src/flags.ts": `export const flags = process.argv.indexOf("--once") >= 0;`,
    });

    expect(findShippedBinaryViolations([binary("apps/demo/dist/cli.js")], files, new Map())).toEqual(
      [
        {
          binary: "demo",
          kind: "argv-walk",
          file: "apps/demo/src/flags.ts",
          line: 1,
          evidence: 'process.argv.indexOf("--once")',
        },
      ],
    );
  });

  it("leaves the reads a binary legitimately makes alone", () => {
    const reads = findArgvWalks({
      relativePath: "apps/demo/src/cli.ts",
      sourceText: [
        `const argv = process.argv.slice(2);`,
        `if (import.meta.url === "file://" + process.argv[1]) main(argv);`,
        `route(process.argv);`,
        `const rest = process.argv.slice(1);`,
      ].join("\n"),
    });

    expect(reads).toEqual([]);
    expect(isArgvRead("slice", "2", undefined)).toBe(true);
    expect(isArgvRead(undefined, undefined, "1")).toBe(true);
    expect(isArgvRead("includes", undefined, undefined)).toBe(false);
    expect(isArgvRead(undefined, undefined, "2")).toBe(false);
    expect(isArgvRead("slice", "3", undefined)).toBe(false);
  });

  it("does not count a walk described in a comment", () => {
    expect(
      findArgvWalks({
        relativePath: "apps/demo/src/cli.ts",
        sourceText: `// replaced the old process.argv.includes("--once") scan with the contract`,
      }),
    ).toEqual([]);
  });
});

describe("declaration and resolution", () => {
  const manifests: BinaryPackageManifest[] = [
    {
      dir: "apps/demo",
      bin: { demo: "dist/cli.js" },
      scripts: {
        bundle:
          "node ../../scripts/bundle-app.mjs --entry src/cli.ts --outfile ../../dist/demo-internal.bundle.min.mjs --asset demo.bundle.min.mjs --minify",
      },
    },
    { dir: "packaging/npm", bin: { "red-skills-demo": "bin/demo.mjs" }, scripts: {} },
  ];

  it("reads every binary out of the bin maps, sorted by name", () => {
    expect(collectDeclaredBinaries(manifests)).toEqual([
      { name: "demo", declaredIn: "apps/demo/package.json", target: "apps/demo/dist/cli.js" },
      {
        name: "red-skills-demo",
        declaredIn: "packaging/npm/package.json",
        target: "packaging/npm/bin/demo.mjs",
      },
    ]);
  });

  it("indexes a bundle by its shipped ASSET name, not only its outfile", () => {
    const bundles = collectBundleEntries(manifests);

    // A shim execs the bundle by the name it ships as; indexing only the
    // outfile would leave the binary unresolved and read as a green pass.
    expect(bundles.get("demo.bundle.min.mjs")).toBe("apps/demo/src/cli.ts");
    expect(bundles.get("demo-internal.bundle.min.mjs")).toBe("apps/demo/src/cli.ts");
  });

  it("inherits a shim's answers from the bundle it forwards its whole argv to", () => {
    const files = tree({
      "packaging/npm/bin/demo.mjs": `
        const bundle = join(here, "..", "dist", "demo.bundle.min.mjs");
        spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
      `,
      "apps/demo/src/cli.ts": CONVERGED_ENTRY,
    });
    const declared = collectDeclaredBinaries(manifests)[1]!;

    const resolved = resolveBinaryEntry(declared, files, collectBundleEntries(manifests));

    expect(resolved.hops).toEqual(["packaging/npm/bin/demo.mjs", "apps/demo/src/cli.ts"]);
    expect(findShippedBinaryViolations([declared], files, collectBundleEntries(manifests))).toEqual(
      [],
    );
  });

  it("holds a shim whose bundle resolves to nothing as unresolved, not as green", () => {
    const files = tree({
      "packaging/npm/bin/demo.mjs": `
        const bundle = join(here, "..", "dist", "missing.bundle.min.mjs");
        spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
      `,
    });
    const declared = collectDeclaredBinaries(manifests)[1]!;

    expect(findShippedBinaryViolations([declared], files, collectBundleEntries(manifests))).toEqual([
      { binary: "red-skills-demo", kind: "unresolved-entry", file: "packaging/npm/bin/demo.mjs" },
    ]);
  });
});

describe("the invariant runs in every gate run", () => {
  it("is declared in REPO_INVARIANT_SUITES so a cone-scoped gate still runs it", () => {
    const declared = REPO_INVARIANT_SUITES.find((suite) => suite.name === "invariants:shipped-binaries");

    expect(declared?.scope).toBe("apps/dev");
    expect(declared?.script).toBe("test:invariants");
  });
});
