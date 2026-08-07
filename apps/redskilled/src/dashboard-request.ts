import type { RedskilledDashboardOptions } from "@reddb-io/redskilled-render";
import type { RedskilledDashboardRenderRequest } from "./protocol.js";

/** Convert renderer vocabulary to the daemon's wire vocabulary. PURE. */
export function redskilledDashboardRequest(
  options: Partial<RedskilledDashboardOptions>,
): RedskilledDashboardRenderRequest {
  return {
    ...(options.mode == null ? {} : { mode: options.mode }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.maxWidth == null ? {} : { max_width: options.maxWidth }),
    ...(options.maxRows == null ? {} : { max_rows: options.maxRows }),
    ...(options.maxHeight == null ? {} : { max_height: options.maxHeight }),
    ...(options.showDeathDetails == null ? {} : { show_death_details: options.showDeathDetails }),
  };
}
