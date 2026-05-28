export function decideConsent(candidates, approved) {
    const approvedOut = [];
    const declinedOut = [];
    for (const c of candidates) {
        if (approved.has(c.name))
            approvedOut.push(c);
        else
            declinedOut.push(c);
    }
    return { approved: approvedOut, declined: declinedOut };
}
