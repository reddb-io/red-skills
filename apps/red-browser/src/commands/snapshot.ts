import { openLiveDriver } from "@reddb-io/cdp-driver";

export async function snapshotCommand(args: string[]): Promise<void> {
  const cdpIdx = args.indexOf("--cdp");
  const cdpUrl = cdpIdx !== -1 ? args[cdpIdx + 1] : undefined;

  const targetIdx = args.indexOf("--target");
  const targetUrl = targetIdx !== -1 ? args[targetIdx + 1] : undefined;

  const driver = await openLiveDriver({ cdpUrl, targetUrl });
  try {
    const snap = await driver.snapshot();
    process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
  } finally {
    await driver.close();
  }
}
