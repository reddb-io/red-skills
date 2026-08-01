/**
 * log-panel — one output channel that follows one Worker's log.
 *
 * ONE channel, not one per Worker: a host that ran forty Workers in a morning
 * would leave forty dead channels in the picker, and every one of them would keep
 * its buffer alive for a process that ended hours ago. Switching Workers clears
 * the panel and replays the new tail, which is stated in the header line so the
 * operator is never left wondering whose log they are reading.
 *
 * Which lines are new is decided by `model/log-follow.ts`, which is pure; this
 * file only writes what it is told to write.
 */
import * as vscode from "vscode";
import { EMPTY_FOLLOW, followTail, type FollowState } from "../model/log-follow.js";
import { tailFile } from "../redskilled/log-tail.js";

export class WorkerLogPanel {
  private readonly channel: vscode.OutputChannel;
  private state: FollowState = EMPTY_FOLLOW;
  private logPath: string | null = null;

  constructor(channel?: vscode.OutputChannel) {
    this.channel = channel ?? vscode.window.createOutputChannel("redskilled — Worker log");
  }

  /** Which Worker the panel is following; `null` before the first one. */
  following(): string | null {
    return this.state.workerId;
  }

  /** Follow `workerId`, reading `logPath`, and reveal the panel. */
  async show(workerId: string, logPath: string | null): Promise<void> {
    this.logPath = logPath;
    if (this.state.workerId !== workerId) {
      this.state = { workerId: null, printed: [] };
    }
    await this.refresh(workerId);
    this.channel.show(true);
  }

  /**
   * Re-read the followed Worker's tail and print only what is new.
   *
   * A call for a Worker the panel is not following is ignored rather than
   * honoured: the poll loop refreshes every tick, and letting it retarget the
   * panel would yank an operator's view away mid-read.
   */
  async refresh(workerId: string): Promise<void> {
    if (this.state.workerId !== null && this.state.workerId !== workerId) return;

    const tail = await tailFile(this.logPath);
    if (!tail.exists) {
      const step = followTail(this.state, workerId, [
        `— ${workerId}: ${tail.reason ?? "no log to read"} —`,
      ]);
      this.write(workerId, step.reset, step.append, tail.path, tail.truncated);
      this.state = step.state;
      return;
    }

    const step = followTail(this.state, workerId, tail.lines);
    this.write(workerId, step.reset, step.append, tail.path, tail.truncated);
    this.state = step.state;
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(
    workerId: string,
    reset: boolean,
    append: readonly string[],
    path: string | null,
    truncated: boolean,
  ): void {
    if (reset) {
      this.channel.clear();
      this.channel.appendLine(`— ${workerId} · ${path ?? "no log path"}${truncated ? " · tail only" : ""} —`);
    }
    for (const line of append) this.channel.appendLine(line);
  }
}
