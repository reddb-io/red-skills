import http from "node:http";

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CdpEvent {
  method: string;
  params: unknown;
}

export class CdpClient {
  private readonly ws: WebSocket;
  private msgId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Map<string, Array<(params: unknown) => void>>();
  private isClosed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string) as CdpResponse | CdpEvent;
      if ("id" in msg) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(`CDP error: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
      } else {
        for (const h of this.listeners.get(msg.method) ?? []) h(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      this.isClosed = true;
      const err = new Error("CDP connection closed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  send(method: string, params?: object): Promise<unknown> {
    if (this.isClosed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  close(): void {
    this.isClosed = true;
    this.ws.close();
  }
}

export interface CdpTarget {
  url: string;
  webSocketDebuggerUrl: string;
}

export async function fetchCdpTarget(
  cdpBase: string,
  targetUrl?: string,
): Promise<CdpTarget> {
  const targets = await fetchJson<CdpTarget[]>(`${cdpBase}/json/list`);
  if (!targets.length) throw new Error("No CDP targets found at " + cdpBase);
  const hit = targetUrl
    ? targets.find((t) => t.url.includes(targetUrl))
    : undefined;
  return hit ?? targets[0];
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
