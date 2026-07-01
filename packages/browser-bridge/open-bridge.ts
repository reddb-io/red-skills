// High-level convenience wrapper — opens a local HTTP bridge, injects the annotation
// and layout-audit SDKs into an HTML artifact, and returns a handle for long-polling.
// Uses the standalone annotation-sdk + layout-audit-sdk (ANNOTATION_SDK / LAYOUT_AUDIT_SDK)
// that POST to /api/annotate and /api/layout-audit-result respectively.
// This coexists with the session-based server.ts API (createBridgeServer / dispatchBridgeRequest).

import http from "node:http";
import { ANNOTATION_SDK } from "./annotation-sdk.js";
import { LAYOUT_AUDIT_SDK } from "./layout-audit-sdk.js";

export interface AnnotationResult {
  element: {
    tagName: string;
    id: string;
    className: string;
    xpath: string;
  };
  charRange: {
    start: number;
    end: number;
    text: string;
  };
  timestamp: string;
}

interface LayoutViolation {
  type: "overflow" | "cutoff" | "overlap";
  selector: string;
  detail: string;
}

interface BridgeLayoutAuditResult {
  pass: boolean;
  violations: LayoutViolation[];
}

export interface BrowserBridge {
  /** Full URL of the bridge server, e.g. `http://127.0.0.1:54321`. */
  url: string;
  port: number;
  waitForAnnotation(timeoutMs?: number): Promise<AnnotationResult>;
  layoutAudit(timeoutMs?: number): Promise<{ pass: boolean; violations: LayoutViolation[] }>;
  close(): Promise<void>;
}

class DeferredQueue<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  take(): Promise<T> {
    if (this.closed) return Promise.reject(new Error("bridge closed"));
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  drain(err: Error): void {
    this.closed = true;
    for (const w of this.waiters) w.reject(err);
    this.waiters.length = 0;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function injectSdks(html: string, bridgeUrl: string): string {
  const sdk = `<script>${ANNOTATION_SDK.replace(/__BRIDGE_URL__/g, bridgeUrl)}</script>\n` +
    `<script>${LAYOUT_AUDIT_SDK.replace(/__BRIDGE_URL__/g, bridgeUrl)}</script>`;
  const lower = html.toLowerCase();
  const idx = lower.lastIndexOf("</body>");
  return idx === -1 ? html + "\n" + sdk : html.slice(0, idx) + sdk + "\n" + html.slice(idx);
}

export async function openBridge(html: string, opts?: { port?: number }): Promise<BrowserBridge> {
  const annotations = new DeferredQueue<AnnotationResult>();
  const auditResults = new DeferredQueue<BridgeLayoutAuditResult>();

  const server = http.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts?.port ?? 0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as { port: number };
  const port = addr.port;
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const injectedHtml = injectSdks(html, bridgeUrl);

  server.on("request", (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injectedHtml);
      return;
    }

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      });
      res.end();
      return;
    }

    if (method === "POST" && url === "/api/annotate") {
      readBody(req).then((body) => {
        annotations.push(JSON.parse(body) as AnnotationResult);
        res.writeHead(204, { "access-control-allow-origin": "*" });
        res.end();
      }).catch(() => { res.writeHead(400); res.end(); });
      return;
    }

    if (method === "POST" && url === "/api/layout-audit-result") {
      readBody(req).then((body) => {
        const { violations } = JSON.parse(body) as { violations: LayoutViolation[] };
        auditResults.push({ pass: violations.length === 0, violations });
        res.writeHead(204, { "access-control-allow-origin": "*" });
        res.end();
      }).catch(() => { res.writeHead(400); res.end(); });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const closeErr = new Error("bridge closed");

  return {
    url: bridgeUrl,
    port,
    waitForAnnotation(timeoutMs = 60_000) {
      return withTimeout(annotations.take(), timeoutMs, "waitForAnnotation");
    },
    layoutAudit(timeoutMs = 30_000) {
      return withTimeout(auditResults.take(), timeoutMs, "layoutAudit");
    },
    close() {
      annotations.drain(closeErr);
      auditResults.drain(closeErr);
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
