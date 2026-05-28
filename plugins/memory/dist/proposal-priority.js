export function computeProposalPriority(input) {
    const reasons = [];
    const failureRatio = failureRatioFromReason(input.reason);
    let score = 0;
    if (failureRatio != null) {
        score += failureRatio * 0.55;
        reasons.push(`failure ratio ${Math.round(failureRatio * 100)}%`);
    }
    if (input.recentFailures > 0) {
        score += Math.min(input.recentFailures, 5) * 0.06;
        reasons.push(`${input.recentFailures} recent failure(s)`);
    }
    if (input.dominantErrorStage) {
        score += 0.08;
        reasons.push(`same error_stage repeated: ${input.dominantErrorStage}`);
    }
    if (input.dominantErrorClass) {
        score += 0.04;
        reasons.push(`same error_class repeated: ${input.dominantErrorClass}`);
    }
    if (input.patchDrafted) {
        score += 0.05;
        reasons.push("structured patch draft generated");
    }
    const rounded = Math.min(1, Math.round(score * 100) / 100);
    return {
        score: rounded,
        priority: rounded >= 0.8 ? "high" : rounded >= 0.6 ? "medium" : "low",
        reasons,
    };
}
export function sortProposalSummaries(proposals) {
    return [...proposals].sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
}
function failureRatioFromReason(reason) {
    const fraction = reason.match(/(\d+)\/(\d+)\s+results failed/);
    if (fraction) {
        const failed = Number(fraction[1]);
        const total = Number(fraction[2]);
        if (Number.isFinite(failed) && Number.isFinite(total) && total > 0)
            return failed / total;
    }
    const percent = reason.match(/\((\d+)%\)/);
    if (percent)
        return Number(percent[1]) / 100;
    return null;
}
