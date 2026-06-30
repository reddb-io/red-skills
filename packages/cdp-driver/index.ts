import { CdpClient, fetchCdpTarget } from "./client.js";
import { buildA11yTree } from "./a11y.js";
import type {
  CdpAXNode,
  ConsoleEntry,
  LiveAppDriver,
  LiveSnapshot,
  NetworkEntry,
} from "./types.js";

export type {
  A11yNode,
  CdpAXNode,
  ConsoleEntry,
  LiveAppDriver,
  LiveSnapshot,
  NetworkEntry,
} from "./types.js";
export { buildA11yTree } from "./a11y.js";

interface OpenLiveDriverOpts {
  /** Base URL of the Chrome DevTools endpoint, e.g. `http://localhost:9222`. */
  cdpUrl?: string;
  /** Optional substring to match against the target page URL. First target is used when omitted. */
  targetUrl?: string;
}

export async function openLiveDriver(
  opts: OpenLiveDriverOpts = {},
): Promise<LiveAppDriver> {
  const cdpBase = opts.cdpUrl ?? "http://localhost:9222";
  const target = await fetchCdpTarget(cdpBase, opts.targetUrl);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("WebSocket connection to CDP failed")),
      { once: true },
    );
  });

  const client = new CdpClient(ws);

  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];

  await client.send("Runtime.enable");
  await client.send("Network.enable");

  client.on("Runtime.consoleAPICalled", (params) => {
    const p = params as {
      type: string;
      args: Array<{ value?: unknown }>;
      timestamp: number;
    };
    const text = p.args.map((a) => String(a.value ?? "")).join(" ");
    consoleEntries.push({
      level: (p.type as ConsoleEntry["level"]) || "log",
      text,
      timestamp: p.timestamp,
    });
  });

  client.on("Network.responseReceived", (params) => {
    const p = params as {
      response: { url: string; status: number; mimeType: string };
      request?: { method?: string };
      timestamp: number;
    };
    networkEntries.push({
      url: p.response.url,
      method: "GET",
      status: p.response.status,
      mimeType: p.response.mimeType,
      timestamp: p.timestamp,
    });
  });

  let refCounter = 0;
  let snapshotCounter = 0;
  let currentRefSet = new Set<number>();

  return {
    async snapshot(): Promise<LiveSnapshot> {
      const result = (await client.send("Accessibility.getFullAXTree")) as {
        nodes: CdpAXNode[];
      };
      const { tree, refSet } = buildA11yTree(
        result.nodes,
        () => ++refCounter,
      );
      currentRefSet = refSet;
      return {
        snapshotId: ++snapshotCounter,
        a11y: tree,
        console: [...consoleEntries],
        network: [...networkEntries],
      };
    },

    isRefStale(ref: number): boolean {
      return !currentRefSet.has(ref);
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}
