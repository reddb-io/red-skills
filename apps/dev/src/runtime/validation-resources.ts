import {
  sampleCurrentProcessResources,
  summarizeResourceWindow,
} from "@reddb-io/redskilled/resource-incidents";
import type { ExecOutput } from "./exec.js";

/** Observability wrapper: a failed probe never changes the child result. */
export async function withValidationResourceEvidence(run: () => Promise<ExecOutput>): Promise<ExecOutput> {
  let before;
  try {
    before = sampleCurrentProcessResources({ kind: "worker", id: "validation" });
  } catch {
    return run();
  }
  const result = await run();
  try {
    const after = sampleCurrentProcessResources({ kind: "worker", id: "validation" });
    return { ...result, resources: summarizeResourceWindow(before, after) };
  } catch {
    return result;
  }
}
