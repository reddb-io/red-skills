export interface TokenLegendRow {
  token: string;
  name: string;
  gloss: string;
}

export const STATUSLINE_LEGEND_ROWS: readonly TokenLegendRow[] = [
  { token: "ctx", name: "context_window", gloss: "Claude context tokens and optional used percentage." },
  { token: "5h", name: "five_hour_usage", gloss: "Claude Pro/Max rolling five-hour usage percentage." },
  { token: "7d", name: "seven_day_usage", gloss: "Claude Pro/Max rolling weekly usage percentage." },
  { token: "prs", name: "open_pull_requests", gloss: "Repository open pull-request count." },
  { token: "cpr", name: "created_pull_requests_today", gloss: "Pull requests created on the local calendar day." },
  { token: "iss", name: "issue_number_or_count", gloss: "Header issue count; worker current issue number." },
  { token: "loc", name: "lines_changed", gloss: "Added and removed line delta as +A -R." },
  { token: "doc", name: "unlanded_docs", gloss: "Unlanded .red glossary/ADR docs from cached local git state." },
  { token: "#", name: "issue", gloss: "Plain monitor current issue marker." },
  { token: "wrk", name: "workers", gloss: "Live AFK worker count in the aggregate statusline block." },
  { token: "rdy", name: "ready_for_agent", gloss: "Cached ready-for-agent queue count." },
  { token: "hmn", name: "ready_for_human", gloss: "Cached ready-for-human queue count." },
  { token: "qtn", name: "quarantine", gloss: "Cached ADR 0122 issue quarantine count." },
  { token: "blk", name: "blocked", gloss: "Blocked issue or worker count, depending on surface." },
  { token: "wai", name: "waiting_count", gloss: "Heartbeat windows with no new stream events." },
  { token: "wait", name: "waiting_count", gloss: "Monitor per-worker waiting counter." },
  { token: "tok", name: "input_output_tokens", gloss: "Input/output token split on monitor rows." },
  { token: "usd", name: "cost_usd", gloss: "Reported USD cost when the runner provides it." },
  { token: "run", name: "runner_model_effort", gloss: "Worker runner plus compact model and effort." },
  { token: "org", name: "origin", gloss: "Worker lane provenance, such as afk or go." },
  { token: "fail", name: "failed", gloss: "Failed issue or worker count on monitor rows." },
  { token: "tks", name: "total_tokens", gloss: "Humanized total input plus output tokens." },
  { token: "tls", name: "tools_called_count", gloss: "Tool-call activity counter." },
  { token: "rsn", name: "reasoning_events", gloss: "Reasoning-event activity counter." },
  { token: "txt", name: "text_chunk_count", gloss: "Text-chunk activity counter." },
  { token: "log", name: "log_lines", gloss: "Observed worker log lines and new-line delta." },
  { token: "id", name: "worker_id", gloss: "TOON worker identifier column." },
  { token: "state", name: "liveness_state", gloss: "TOON worker live, quiet, or stale state." },
  { token: "runner", name: "runner", gloss: "TOON worker runner column." },
  { token: "issue", name: "issue_number", gloss: "TOON worker current issue column." },
  { token: "phase", name: "pipeline_phase", gloss: "Worker macro pipeline position shown in the statusline." },
  { token: "activity", name: "current_activity", gloss: "TOON worker current activity column." },
  { token: "done", name: "done_count", gloss: "TOON worker closed issue count." },
  { token: "total", name: "total_count", gloss: "TOON worker queue total count." },
  { token: "blocked", name: "blocked_count", gloss: "TOON worker blocked count." },
  { token: "failed", name: "failed_count", gloss: "TOON worker failed count." },
  { token: "elapsed", name: "elapsed_time", gloss: "TOON worker elapsed runtime." },
  { token: "added", name: "diff_added", gloss: "TOON worker added line count." },
  { token: "removed", name: "diff_removed", gloss: "TOON worker removed line count." },
  { token: "in_tok", name: "input_tokens", gloss: "TOON worker input token count." },
  { token: "out_tok", name: "output_tokens", gloss: "TOON worker output token count." },
  { token: "cost_usd", name: "cost_usd", gloss: "TOON worker USD cost." },
];

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

export function renderStatuslineLegend(rows: readonly TokenLegendRow[] = STATUSLINE_LEGEND_ROWS): string {
  const tokenW = Math.max("token".length, ...rows.map((row) => row.token.length));
  const nameW = Math.max("name".length, ...rows.map((row) => row.name.length));
  const header = "token  name  gloss";
  const body = rows.map((row) => `${pad(row.token, tokenW)}  ${pad(row.name, nameW)}  ${row.gloss}`);
  return [header, ...body].join("\n");
}
