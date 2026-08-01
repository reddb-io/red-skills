/**
 * package-vsix — collect the shipped files and write the installable archive.
 *
 * Run through `pnpm -C apps/vscode-redskilled package`, which builds `out/`
 * first. It writes to the repo's gitignored `dist/` and **never publishes**: the
 * marketplace is not a destination this repo has, and a script that could push
 * there is one an accident can run.
 *
 * NOT a shipped binary: there is no `bin` entry and nothing installs it, so it
 * carries none of the `--version` / `--help` obligations a binary inherits.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildZip,
  renderContentTypes,
  renderVsixManifest,
  type VsixEntry,
} from "./packaging/vsix.js";

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(EXTENSION_ROOT, "..", "..");

/**
 * What ships, in the order it is written into the archive.
 *
 * A declared list rather than a walk of the directory: `.vscodeignore` states
 * what is excluded and this states what is included, and the two agreeing is
 * checked by the suite. A walk would silently ship whatever a build left behind.
 */
const SHIPPED: readonly { readonly source: string; readonly target: string }[] = [
  { source: join(EXTENSION_ROOT, "package.json"), target: "extension/package.json" },
  { source: join(EXTENSION_ROOT, "README.md"), target: "extension/README.md" },
  { source: join(REPO_ROOT, "LICENSE"), target: "extension/LICENSE.txt" },
  { source: join(EXTENSION_ROOT, "media", "redskilled.svg"), target: "extension/media/redskilled.svg" },
  { source: join(EXTENSION_ROOT, "out", "extension.cjs"), target: "extension/out/extension.cjs" },
];

export interface PackagedVsix {
  readonly outputPath: string;
  readonly archive: Buffer;
  readonly entries: readonly VsixEntry[];
}

/**
 * Build the archive in memory and return it beside the path it belongs at.
 *
 * Returned rather than only written, so the suite can assert the bytes that ship
 * instead of a rehearsal of them.
 */
export async function packageVsix(options: { modified?: Date } = {}): Promise<PackagedVsix> {
  const manifest = JSON.parse(await readFile(join(EXTENSION_ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    publisher: string;
    displayName: string;
    description: string;
    engines: { vscode: string };
    categories: string[];
  };

  const files: VsixEntry[] = [];
  for (const shipped of SHIPPED) {
    files.push({ path: shipped.target, contents: await readFile(shipped.source) });
  }

  const entries: VsixEntry[] = [
    {
      path: "extension.vsixmanifest",
      contents: Buffer.from(
        renderVsixManifest({
          publisher: manifest.publisher,
          name: manifest.name,
          version: manifest.version,
          displayName: manifest.displayName,
          description: manifest.description,
          engineVersion: manifest.engines.vscode,
          categories: manifest.categories,
        }),
        "utf8",
      ),
    },
    {
      path: "[Content_Types].xml",
      contents: Buffer.from(
        renderContentTypes([
          "vsixmanifest",
          "xml",
          ...files.map((file) => extname(file.path).replace(".", "")),
        ]),
        "utf8",
      ),
    },
    ...files,
  ];

  return {
    outputPath: join(REPO_ROOT, "dist", `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`),
    // A fixed stamp, so two builds of one tree produce identical bytes. The zip
    // format has nowhere to record "no date", and the clock is the only thing
    // that would otherwise make a reproducible build irreproducible.
    archive: buildZip(entries, options.modified ?? new Date("1980-01-01T00:00:00Z")),
    entries,
  };
}

/** True when this module was run rather than imported. */
const isEntry = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntry) {
  const packaged = await packageVsix();
  await mkdir(dirname(packaged.outputPath), { recursive: true });
  await writeFile(packaged.outputPath, packaged.archive);
  process.stdout.write(
    `${packaged.outputPath}\n` +
    `  ${packaged.entries.length} entries · ${packaged.archive.length} bytes\n` +
    "  not published: install it with `code --install-extension <path>`\n",
  );
}
