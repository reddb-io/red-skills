import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectToonJsonGuardReport,
  collectToonJsonIoFindingsFromFiles,
  formatToonJsonGuardFailureMessage,
  formatToonJsonGuardViolations,
  type ToonJsonAllowlistEntry,
} from "../src/core/toon-json-guard.js";
import { ALLOWLIST_PATH } from "../src/core/shared-gate.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DEV_SRC = join(import.meta.dirname, "..", "src");

describe("toon JSON file I/O guard", () => {
  it("ratchets the live apps/packages JSON file I/O allowlist", async () => {
    const report = await collectToonJsonGuardReport(ROOT);
    const violations = formatToonJsonGuardViolations(report);

    // The message is the point: a bare array diff tells a worker nothing it can
    // act on, so carry the offending paths + the allowlist file into the failure.
    expect(violations, formatToonJsonGuardFailureMessage(violations)).toEqual([]);
  });

  it("names the offending path and the allowlist file in the failure message", () => {
    // The exact recurring shape (#2762): a `.toon` file written with
    // JSON.stringify. The runtime decoder sniffs JSON-or-TOON and accepts it,
    // so it looks correct locally and is wrong by policy.
    const source = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";

      export function persistLedger(root: string, ledger: unknown) {
        writeFileSync(join(root, "ledger.toon"), JSON.stringify(ledger), "utf8");
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/rsp/src/ledger.ts", sourceText: source },
    ]);
    expect(findings).toHaveLength(1);

    const message = formatToonJsonGuardFailureMessage(
      formatToonJsonGuardViolations({ findings, allowlist: [] }),
    );

    expect(message).toContain("apps/rsp/src/ledger.ts");
    expect(message).toContain(ALLOWLIST_PATH);
    expect(message).toContain("JSON.stringify");
    expect(formatToonJsonGuardFailureMessage([])).toBe("");
  });

  it("rejects a new stack-owned JSON.stringify file write until allowlisted", () => {
    const source = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";

      export function persistState(root: string) {
        writeFileSync(join(root, "state.json"), JSON.stringify({ ok: true }), "utf8");
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/state.ts", sourceText: source },
    ]);
    expect(findings).toHaveLength(1);

    expect(formatToonJsonGuardViolations({ findings, allowlist: [] })).toEqual([
      expect.stringContaining(findings[0]!.id),
    ]);

    const allowlist: ToonJsonAllowlistEntry[] = [
      {
        id: findings[0]!.id,
        classification: "migrate",
      },
    ];

    expect(formatToonJsonGuardViolations({ findings, allowlist })).toEqual([]);
  });

  it("mints a line-independent id — a pure line shift keeps the allowlist entry valid", () => {
    const write = `writeFileSync(join(root, "state.json"), JSON.stringify({ ok: true }), "utf8");`;
    const near = `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nexport function persistState(root: string) {\n  ${write}\n}\n`;
    const shifted = `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n// an unrelated comment\n// and another line\n// and a third line above the site\nexport function persistState(root: string) {\n  ${write}\n}\n`;
    const [a] = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/state.ts", sourceText: near },
    ]);
    const [b] = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/state.ts", sourceText: shifted },
    ]);
    expect(a!.line).not.toBe(b!.line); // the statement genuinely moved
    expect(a!.id).toBe(b!.id); // ...but the snippet-anchored id is stable
  });

  it("flags a JSON payload written to a socket, naming the location (#2948)", () => {
    // The exact shape the daemon shipped for its whole life: every file it wrote
    // was TOON, and its wire was JSON, because the guard had no opinion about a
    // socket.
    const source = `
      import type { Socket } from "node:net";

      export function writeResponse(socket: Socket, response: unknown): void {
        socket.write(\`\${JSON.stringify(response)}\\n\`);
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/redskilled/src/daemon.ts", sourceText: source },
    ]);
    expect(findings.map((finding) => finding.kind)).toEqual(["json-stringify-wire-write"]);

    const message = formatToonJsonGuardFailureMessage(
      formatToonJsonGuardViolations({ findings, allowlist: [] }),
    );
    expect(message).toContain("apps/redskilled/src/daemon.ts");
    expect(message).toContain("json-stringify-wire-write");
    // Names the encoder to use, not only the offence.
    expect(message).toContain("@reddb-io/toon");
    expect(message).toContain("encodeWireFrame");
  });

  it("flags JSON.parse of a framed socket payload, through the buffer that carried it", () => {
    // The read half of the same wire: the chunk arrives on `data`, accumulates in
    // a buffer, and one line is cut out of it before JSON.parse sees it.
    const source = `
      import type { Socket } from "node:net";

      export function handleSocket(socket: Socket, handler: (request: unknown) => void): void {
        let buffer = "";
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf("\\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          handler(JSON.parse(line));
        });
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/redskilled/src/daemon.ts", sourceText: source },
    ]);
    expect(findings.map((finding) => finding.kind)).toEqual(["json-parse-wire-read"]);
  });

  it("passes error-message quoting — a quoted path is legibility, not a payload", () => {
    // Both spellings of quoting: inside a thrown message, and interpolated into
    // prose on the wire itself. Neither is a payload.
    const source = `
      import type { Socket } from "node:net";

      export function refuse(socket: Socket, socketPath: string): never {
        socket.write(\`redskilled daemon is unreachable on \${JSON.stringify(socketPath)}\\n\`);
        throw new Error(\`redskilled daemon is unreachable on \${JSON.stringify(socketPath)}\`);
      }
    `;
    expect(
      collectToonJsonIoFindingsFromFiles([
        { relativePath: "apps/redskilled/src/client.ts", sourceText: source },
      ]),
    ).toEqual([]);
  });

  it("passes an explicit --json opt-out — the mandate governs the default", () => {
    const source = `
      import type { Socket } from "node:net";

      export function report(socket: Socket, argv: string[], options: { json: boolean }, info: unknown): void {
        socket.write(argv.includes("--json") ? \`\${JSON.stringify(info)}\\n\` : encodeWireFrame(info, "toon"));
        if (options.json) {
          socket.write(\`\${JSON.stringify(info, null, 2)}\\n\`);
        }
      }
    `;
    expect(
      collectToonJsonIoFindingsFromFiles([
        { relativePath: "apps/redskilled/src/cli.ts", sourceText: source },
      ]),
    ).toEqual([]);
  });

  it("ratchets a wire finding the same way a file finding is ratcheted", () => {
    const source = `
      import type { Socket } from "node:net";
      export function ping(socket: Socket): void {
        socket.write(JSON.stringify({ op: "ping" }));
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/ping.ts", sourceText: source },
    ]);
    expect(findings).toHaveLength(1);
    expect(formatToonJsonGuardViolations({ findings, allowlist: [] })).toEqual([
      expect.stringContaining(findings[0]!.id),
    ]);
    const allowlist: ToonJsonAllowlistEntry[] = [{ id: findings[0]!.id, classification: "migrate" }];
    expect(formatToonJsonGuardViolations({ findings, allowlist })).toEqual([]);
  });

  it("stays test-only — no runtime src imports the guard or typescript (keeps the compiler out of the bundle)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.") || entry.name === "toon-json-guard.ts") continue;
        const text = readFileSync(p, "utf8");
        if (/from ["'][^"']*toon-json-guard(\.js)?["']/.test(text) || /from ["']typescript["']/.test(text)) {
          offenders.push(relative(ROOT, p));
        }
      }
    };
    walk(DEV_SRC);
    // The guard imports the full `typescript` compiler; if any other runtime src
    // imports the guard (or typescript directly) it lands in dev.bundle.min.mjs
    // — the regression the release contract check caught. Keep it test-only.
    expect(offenders).toEqual([]);
  });
});
