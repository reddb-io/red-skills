import { readFile } from "node:fs/promises";
import { openBridge } from "@reddb-io/browser-bridge";

export async function annotateCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    process.stderr.write("Error: html-file argument required\n");
    process.exit(1);
  }

  const skipAudit = args.includes("--skip-audit");
  const timeoutIdx = args.indexOf("--timeout");
  const annotationTimeoutMs =
    timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1] ?? "60000", 10) : 60_000;

  const html = await readFile(filePath, "utf8");
  const bridge = await openBridge(html);

  process.stderr.write(`Bridge ready — open in your browser: ${bridge.url}\n`);

  if (!skipAudit) {
    const audit = await bridge.layoutAudit(30_000);
    if (!audit.pass) {
      process.stderr.write(
        `Layout audit FAILED — fix violations before declaring done:\n`,
      );
      for (const v of audit.violations) {
        process.stderr.write(`  [${v.type}] ${v.selector}: ${v.detail}\n`);
      }
      await bridge.close();
      process.exit(2);
    }
    process.stderr.write("Layout audit passed.\n");
  }

  const annotation = await bridge.waitForAnnotation(annotationTimeoutMs);
  process.stdout.write(JSON.stringify(annotation, null, 2) + "\n");
  await bridge.close();
}
