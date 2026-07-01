export interface A11yNode {
  ref: number;
  role: string;
  name: string;
  description?: string;
  value?: string;
  children: A11yNode[];
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
}

export interface LiveSnapshot {
  snapshotId: number;
  a11y: A11yNode[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

export interface LiveAppDriver {
  snapshot(): Promise<LiveSnapshot>;
  /** Returns true when `ref` was not present in the most recent snapshot. */
  isRefStale(ref: number): boolean;
  close(): Promise<void>;
}

export interface CdpAXNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: string };
  childIds?: string[];
  ignored?: boolean;
}
