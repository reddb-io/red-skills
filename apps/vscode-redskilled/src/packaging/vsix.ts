/**
 * vsix — the installable package, built here rather than by `vsce`.
 *
 * A `.vsix` is an OPC zip: `extension.vsixmanifest` and `[Content_Types].xml` at
 * the root, and every shipped file under `extension/`. That is a hundred lines of
 * well-specified format, and the alternative — `@vscode/vsce` as a devDependency
 * — is 290 packages and 130 MB that every CI install of this workspace would pay
 * for, to produce a zip nothing publishes. This repo builds the zip.
 *
 * **Deterministic on purpose.** The entry order is the caller's, timestamps come
 * from a passed-in date, and nothing reads the clock — so two builds of one tree
 * produce identical bytes and a diff between two `.vsix` files means a diff in
 * the extension.
 *
 * Store-only for tiny files, deflate for the rest, and no zip64: an extension
 * that needed 4 GB entries would have a different problem. PURE apart from
 * `zlib`.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface VsixEntry {
  /** The path inside the archive, forward slashes, no leading slash. */
  readonly path: string;
  readonly contents: Buffer;
}

export interface VsixManifestInput {
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly engineVersion: string;
  readonly categories: readonly string[];
}

/**
 * The `extension.vsixmanifest` the marketplace format requires.
 *
 * Hand-rendered rather than templated from a library because it is a fixed
 * document with five substitutions, and every value is escaped on the way in —
 * a description carrying an `&` must not produce a package no editor can open.
 */
export function renderVsixManifest(input: VsixManifestInput): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    "  <Metadata>",
    `    <Identity Language="en-US" Id="${escapeXml(input.name)}" Version="${escapeXml(input.version)}" Publisher="${escapeXml(input.publisher)}" />`,
    `    <DisplayName>${escapeXml(input.displayName)}</DisplayName>`,
    `    <Description xml:space="preserve">${escapeXml(input.description)}</Description>`,
    `    <Tags>${escapeXml(input.categories.join(","))}</Tags>`,
    `    <Categories>${escapeXml(input.categories.join(","))}</Categories>`,
    "    <GalleryFlags>Public</GalleryFlags>",
    "    <Properties>",
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(input.engineVersion)}" />`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/reddb-io/red-skills" />',
    "    </Properties>",
    `    <License>extension/LICENSE.txt</License>`,
    "  </Metadata>",
    "  <Installation>",
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
    "  </Installation>",
    "  <Dependencies/>",
    "  <Assets>",
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />',
    `    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />`,
    "  </Assets>",
    "</PackageManifest>",
    "",
  ].join("\n");
}

/** The `[Content_Types].xml` an OPC reader needs to know what each suffix is. */
export function renderContentTypes(extensions: readonly string[]): string {
  const known: Record<string, string> = {
    json: "application/json",
    vsixmanifest: "text/xml",
    md: "text/markdown",
    txt: "text/plain",
    cjs: "application/javascript",
    js: "application/javascript",
    svg: "image/svg+xml",
    png: "image/png",
    toon: "text/plain",
  };
  const unique = [...new Set(extensions.map((extension) => extension.toLowerCase()))].sort();
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ...unique.map(
      (extension) =>
        `  <Default Extension="${escapeXml(extension)}" ContentType="${known[extension] ?? "application/octet-stream"}" />`,
    ),
    "</Types>",
    "",
  ].join("\n");
}

/** Build the whole archive. Entries are written in the order given. */
export function buildZip(entries: readonly VsixEntry[], modified: Date): Buffer {
  const { time, date } = dosStamp(modified);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.contents);
    // Store when deflate does not help: a two-line JSON is bigger compressed, and
    // an archive that grew a file to compress it is a lie about its own format.
    const deflated = deflateRawSync(entry.contents, { level: 9 });
    const stored = deflated.length >= entry.contents.length;
    const body = stored ? entry.contents : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, end]);
}

/**
 * Read an archive back into its entries, by its central directory.
 *
 * Here rather than only in a test, because a packager whose output nothing in the
 * repo can open is a packager nobody can check: this is what lets the suite
 * assert the manifest and the file set of the very bytes that ship.
 */
export function readZip(archive: Buffer): VsixEntry[] {
  const endOffset = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);

  const entries: VsixEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("vsix: central directory entry is not one");
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const path = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = archive.subarray(bodyStart, bodyStart + compressedSize);

    entries.push({ path, contents: method === 0 ? Buffer.from(body) : inflateRawSync(body) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("vsix: no end-of-central-directory record — this is not a zip");
}

/** MS-DOS time and date, the only stamp a zip local header can carry. */
export function dosStamp(when: Date): { time: number; date: number } {
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  return { time, date };
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
