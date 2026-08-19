/** Secret-free numeric envelope observed around one validation command. */
export interface ValidationResourceEvidence {
  source: "cgroup-v2" | "process-tree" | "unavailable";
  sampled_before: string;
  sampled_after: string;
  memory_current_before_bytes: number;
  memory_current_after_bytes: number;
  memory_peak_bytes: number;
  memory_max_bytes: number | null;
  cpu_usage_delta_usec: number;
  cpu_throttled_delta_usec: number;
  pids_peak: number;
  memory_events_delta: Record<string, number>;
  pids_events_delta: Record<string, number>;
}
