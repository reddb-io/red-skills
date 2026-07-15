import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCatalogToonVersion, type CatalogToonVersion } from "../src/core/toon-version.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

type PinForm = "version" | "tag";

interface ToonPinSite {
  readonly name: string;
  readonly path: string;
  readonly form: PinForm;
  readonly pattern: RegExp;
}

const TOON_PIN_SITES: readonly ToonPinSite[] = [
  {
    name: "workflow.red-workspace-ci.tq-install-version",
    path: ".github/workflows/red-workspace-ci.yml",
    form: "tag",
    pattern: /TQ_VERSION:\s+(v\d+\.\d+\.\d+)/,
  },
  {
    name: "workflow.red-rsp-benchmark-ci.tq-install-version",
    path: ".github/workflows/red-rsp-benchmark-ci.yml",
    form: "tag",
    pattern: /TQ_VERSION:\s+(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.interview.tq-install-env",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.interview.tq-install-url",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "tag",
    pattern: /raw\.githubusercontent\.com\/reddb-io\/toon\/(v\d+\.\d+\.\d+)\/install\.sh/,
  },
  {
    name: "red-setup.interview.installed-version",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "version",
    pattern: /The installed version must be `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.reference.tq-install-env",
    path: "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.reference.host-binary-check",
    path: "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    form: "version",
    pattern: /pinned to `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.write-contract.host-binary-record",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /host_binaries\.tq\.version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.write-contract.tq-install-env",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.write-contract.tq-install-url",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "tag",
    pattern: /raw\.githubusercontent\.com\/reddb-io\/toon\/(v\d+\.\d+\.\d+)\/install\.sh/,
  },
  {
    name: "red-setup.write-contract.verify-version",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /`tq --version` reports `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.write-contract.config-record",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /\n\s+version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.config-template.host-binary-record",
    path: "plugins/dev/skills/engineering/red-setup/config-template.yaml",
    form: "version",
    pattern: /\n\s+version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-doctor.skill.host-binary-pin",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "version",
    pattern: /host_binaries\.tq\.version` \(pin `(\d+\.\d+\.\d+)`\)/,
  },
  {
    name: "red-doctor.skill.remediation-env",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-doctor.skill.remediation-url",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "tag",
    pattern: /raw\.githubusercontent\.com\/reddb-io\/toon\/(v\d+\.\d+\.\d+)\/install\.sh/,
  },
];

async function readSitePin(site: ToonPinSite): Promise<string> {
  const text = await readFile(join(ROOT, site.path), "utf8");
  const match = site.pattern.exec(text);
  if (!match?.[1]) {
    throw new Error(`toon pin site ${site.name} did not match ${site.path}`);
  }
  return match[1];
}

async function toonPinDrift(version: CatalogToonVersion): Promise<string[]> {
  const failures: string[] = [];
  for (const site of TOON_PIN_SITES) {
    const expected = site.form === "tag" ? version.tag : version.version;
    const actual = await readSitePin(site);
    if (actual !== expected) {
      failures.push(`${site.name}: expected ${expected}, found ${actual}`);
    }
  }
  return failures;
}

describe("toon catalog version contract", () => {
  it("derives the toon/tq version from the pnpm catalog", () => {
    expect(readCatalogToonVersion(ROOT)).toEqual({
      packageName: "@reddb-io/toon",
      version: "0.3.0",
      tag: "v0.3.0",
    });
  });

  it("keeps every registered derived toon/tq pin aligned with the catalog", async () => {
    await expect(toonPinDrift(readCatalogToonVersion(ROOT))).resolves.toEqual([]);
  });

  it("names every stale registered site after a catalog-only bump", async () => {
    const failures = await toonPinDrift({
      packageName: "@reddb-io/toon",
      version: "9.9.9",
      tag: "v9.9.9",
    });

    expect(failures).toEqual(TOON_PIN_SITES.map((site) => expect.stringContaining(`${site.name}:`)));
  });
});
