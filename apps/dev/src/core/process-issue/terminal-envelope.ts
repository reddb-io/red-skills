import { emitEnvelope, type SectionBodies } from "../envelope-emit.js";
import type { AttemptStatus } from "../envelope.js";
import { formatValidationScope, type ValidationScope } from "../validation-scope.js";
import type { ProcessIssueDeps, ProcessIssueInput, WorkerBaseResolution } from "./types.js";
import { formatBaseResolution } from "./types.js";

/** The terminal-stage state needed to assemble an Envelope. */
export interface EnvelopeStage {
  deps: ProcessIssueDeps;
  input: ProcessIssueInput;
  branch: string;
  startedEpoch: number;
  resolvedBase?: WorkerBaseResolution;
  noBranchLink?: boolean;
}

export async function emitFailure(
  c: EnvelopeStage,
  status: AttemptStatus,
  diffLabel: string,
  sections: SectionBodies,
): Promise<boolean> {
  const { deps, input } = c;
  const durationS = deps.nowEpoch() - c.startedEpoch;
  const result = await emitEnvelope(deps.envelope, {
    status,
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    diff: diffLabel,
    repo: c.noBranchLink ? "" : input.repo,
    repoDir: input.repoDir,
    worktreeRel: input.attemptDir,
    diffstat: "",
    sections: { ...sections, ...(c.resolvedBase ? { base: formatBaseResolution(c.resolvedBase) } : {}) },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner },
  });
  return result.posted;
}

export async function emitDone(
  c: EnvelopeStage,
  mergeSha: string,
  durationS: number,
  validationSidecar: string[],
  validationScope?: ValidationScope,
  validationNotice?: string,
  appraisalScore?: number,
): Promise<boolean> {
  const { deps, input } = c;
  const scopeHeader = validationScope ? `${formatValidationScope(validationScope)}\n` : "";
  const validationBody = [validationNotice, `${scopeHeader}${validationSidecar.join("\n")}`]
    .filter((part) => part && part.trim().length > 0)
    .join("\n");
  const result = await emitEnvelope(deps.envelope, {
    status: "done",
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: c.branch,
    attempt: input.attempt,
    mergeSha,
    diff: "merged",
    sections: {
      ...(appraisalScore === undefined ? {} : { appraisal: `Score: ${appraisalScore}` }),
      validation: validationBody,
      ...(c.resolvedBase ? { base: formatBaseResolution(c.resolvedBase) } : {}),
    },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner, merge_sha: mergeSha },
  });
  return result.posted;
}
