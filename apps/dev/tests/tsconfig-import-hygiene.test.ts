import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BASE_CONFIG = join(ROOT, "tsconfig.base.json");
const DEV_ROOT = join(ROOT, "apps", "dev");
const OPTED_OUT_CONFIGS = [
  "apps/benchmark-memory/tsconfig.json",
  "apps/brain/tsconfig.json",
  "apps/memory/tsconfig.json",
  "apps/rsp/tsconfig.json",
  "packages/worker/tsconfig.json",
];
const RATCHETED_CONFIGS = ["apps/dev/tsconfig.json"];
const DEV_UNUSED_IMPORT_DEBT: Record<string, number> = {
  // #4032 deleted the janitor's boot phase; one import it shared with the
  // surviving code is now unreferenced. Declared rather than force-removed,
  // because the two symbols next to it ARE used and a blind strip broke them.
  "src/core/boot.ts": 1,
  "src/core/dashboard.ts": 1,
  "src/core/process-issue/lifecycle.ts": 56,
  "src/core/process-issue/recovery.ts": 90,
  "src/core/process-issue/terminal.ts": 70,
  "src/core/process-issue/types.ts": 67,
  "src/core/review-extract.ts": 1,
  "src/core/session.ts": 3,
  "src/core/skill-audit-extract.ts": 1,
  "src/runtime/review-gh.ts": 1,
};

type TsConfig = {
  extends?: string;
  compilerOptions?: {
    noUnusedLocals?: boolean;
  };
};

async function listTsConfigs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter((entry) => entry.name !== "node_modules" && entry.name !== "dist")
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return listTsConfigs(path);
        return entry.isFile() && /^tsconfig(?:\..+)?\.json$/.test(entry.name) ? [path] : [];
      }),
  );
  return paths.flat().sort();
}

async function readTsConfig(path: string): Promise<TsConfig> {
  return JSON.parse(await readFile(path, "utf8")) as TsConfig;
}

async function resolvesToSharedBase(path: string): Promise<boolean> {
  if (path === BASE_CONFIG) return true;
  const config = await readTsConfig(path);
  if (!config.extends) return false;
  return resolvesToSharedBase(resolve(dirname(path), config.extends));
}

async function listTypeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptSources(path);
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return paths.flat().sort();
}

function importedIdentifiers(sourceFile: ts.SourceFile): ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      identifiers.push(statement.name);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;

    if (statement.importClause.name) identifiers.push(statement.importClause.name);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) identifiers.push(bindings.name);
    if (bindings && ts.isNamedImports(bindings)) {
      identifiers.push(...bindings.elements.map((element) => element.name));
    }
  }

  return identifiers;
}

async function unusedImportDebt(): Promise<Record<string, number>> {
  const paths = await listTypeScriptSources(join(DEV_ROOT, "src"));
  const program = ts.createProgram(paths, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const debt: Record<string, number> = {};

  for (const sourceFile of program.getSourceFiles()) {
    if (!paths.includes(sourceFile.fileName)) continue;

    const imported = importedIdentifiers(sourceFile).flatMap((identifier) => {
      const symbol = checker.getSymbolAtLocation(identifier);
      return symbol ? [{ identifier, symbol }] : [];
    });
    const referenced = new Set<ts.Symbol>();

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
      // A shorthand property (`{ doLanding }`) resolves to the PROPERTY symbol,
      // not to the imported binding it reads — counting only `getSymbolAtLocation`
      // would report a port-wiring module's every import as unused debt (#2665).
      if (ts.isShorthandPropertyAssignment(node)) {
        const shorthand = checker.getShorthandAssignmentValueSymbol(node);
        if (shorthand) referenced.add(shorthand);
      }
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) referenced.add(symbol);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);

    const count = imported.filter(({ symbol }) => !referenced.has(symbol)).length;
    if (count > 0) debt[relative(DEV_ROOT, sourceFile.fileName)] = count;
  }

  return debt;
}

describe("workspace TypeScript import hygiene", () => {
  it("enables noUnusedLocals from one shared base with a bounded package opt-out list", async () => {
    const base = await readTsConfig(BASE_CONFIG);
    expect(base.compilerOptions?.noUnusedLocals).toBe(true);

    const configs = (
      await Promise.all([listTsConfigs(join(ROOT, "apps")), listTsConfigs(join(ROOT, "packages"))])
    ).flat();

    for (const path of configs) {
      expect(await resolvesToSharedBase(path), relative(ROOT, path)).toBe(true);
    }

    const disabled = (
      await Promise.all(
        configs.map(async (path) => ({
          path: relative(ROOT, path),
          disabled: (await readTsConfig(path)).compilerOptions?.noUnusedLocals === false,
        })),
      )
    )
      .filter(({ disabled }) => disabled)
      .map(({ path }) => path);

    const optedOut = disabled.filter((path) => !RATCHETED_CONFIGS.includes(path)).sort();

    expect(optedOut).toEqual(OPTED_OUT_CONFIGS);
    expect(disabled.filter((path) => RATCHETED_CONFIGS.includes(path))).toEqual(
      RATCHETED_CONFIGS,
    );
  });

  it("rejects new unused imports in the ratcheted dev package", async () => {
    expect(await unusedImportDebt()).toEqual(DEV_UNUSED_IMPORT_DEBT);
  });
});
