import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyCandidateMemory } from "./store-classifier.js";
import { redactSensitiveText, scanPrivacyRecords, } from "./privacy.js";
export function inboxRoot(rootDir) {
    return join(rootDir, ".red", "memory", "inbox");
}
export async function quarantineInboxItem(rootDir, input, now = new Date()) {
    const fact = input.fact.trim();
    const reason = input.reason.trim();
    const evidenceSummary = input.evidenceSummary.trim();
    if (!fact)
        throw new Error("memory inbox quarantine needs a proposed fact");
    if (!reason)
        throw new Error("memory inbox quarantine requires --reason <text>");
    if (!evidenceSummary)
        throw new Error("memory inbox quarantine requires --evidence <summary>");
    const createdAt = now.toISOString();
    const id = `inbox-${hashParts([fact, reason, evidenceSummary, createdAt]).slice(0, 12)}`;
    const fields = {
        fact,
        reason,
        evidenceSummary,
    };
    const privacyFindings = scanPrivacyRecords([
        {
            id,
            location: `memory inbox ${id}`,
            fields,
        },
    ]);
    const provenance = normalizeProvenance(input.provenance);
    const item = {
        id,
        status: "quarantined",
        fact: redactSensitiveText(fact),
        reason: redactSensitiveText(reason),
        evidenceSummary: redactSensitiveText(evidenceSummary),
        classification: classifyCandidateMemory(fact),
        privacyFindings,
        provenance,
        createdAt,
        updatedAt: createdAt,
    };
    await writeInboxItem(rootDir, item);
    return item;
}
export async function listInboxItems(rootDir) {
    let entries;
    try {
        entries = await readdir(inboxRoot(rootDir));
    }
    catch (err) {
        if (err.code === "ENOENT")
            return [];
        throw err;
    }
    const items = [];
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        items.push(await readInboxItem(rootDir, entry.slice(0, -".json".length)));
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
export async function readInboxItem(rootDir, id) {
    const path = inboxPath(rootDir, id);
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw new Error(`memory inbox item not found: ${id}`);
        }
        throw err;
    }
}
export async function approveInboxItem(rootDir, id, now = new Date()) {
    const item = await readInboxItem(rootDir, id);
    if (item.status === "approved")
        return item;
    if (item.status !== "quarantined") {
        throw new Error(`memory inbox item ${id} cannot be approved from status ${item.status}`);
    }
    const updated = {
        ...item,
        status: "approved",
        approvedAt: now.toISOString(),
        updatedAt: now.toISOString(),
    };
    await writeInboxItem(rootDir, updated);
    return updated;
}
export async function rejectInboxItem(rootDir, id, rejectionReason, now = new Date()) {
    const item = await readInboxItem(rootDir, id);
    const reason = rejectionReason.trim();
    if (!reason)
        throw new Error("memory inbox reject requires --reason <text>");
    if (item.status === "promoted") {
        throw new Error(`memory inbox item ${id} cannot be rejected after promotion`);
    }
    if (item.status === "rejected")
        return item;
    const updated = {
        ...item,
        status: "rejected",
        rejectionReason: redactSensitiveText(reason),
        rejectedAt: now.toISOString(),
        updatedAt: now.toISOString(),
    };
    await writeInboxItem(rootDir, updated);
    return updated;
}
export async function markInboxItemPromoted(rootDir, id, promotedRid, now = new Date()) {
    const item = await readInboxItem(rootDir, id);
    if (item.status !== "approved") {
        throw new Error(`memory inbox item ${id} must be approved before promotion`);
    }
    const updated = {
        ...item,
        status: "promoted",
        promotedRid,
        promotedAt: now.toISOString(),
        updatedAt: now.toISOString(),
    };
    await writeInboxItem(rootDir, updated);
    return updated;
}
export function inboxItemToProvenance(item) {
    return {
        source_kind: item.provenance.sourceKind,
        ...(item.provenance.writer ? { writer: item.provenance.writer } : {}),
        ...(item.provenance.command ? { command: item.provenance.command } : {}),
        ...(item.provenance.hook ? { hook: item.provenance.hook } : {}),
        confidence: item.provenance.confidence,
        evidence: [item.evidenceSummary],
        ...(item.provenance.scope ? { scope: item.provenance.scope } : {}),
    };
}
async function writeInboxItem(rootDir, item) {
    await mkdir(inboxRoot(rootDir), { recursive: true });
    await writeFile(inboxPath(rootDir, item.id), `${JSON.stringify(item, null, 2)}\n`, "utf8");
}
function inboxPath(rootDir, id) {
    if (!/^inbox-[a-f0-9]{12}$/.test(id))
        throw new Error(`invalid memory inbox id: ${id}`);
    return join(inboxRoot(rootDir), `${id}.json`);
}
function normalizeProvenance(input = {}) {
    const sourceKind = input.sourceKind ?? "manual";
    const confidence = input.confidence ?? "INFERRED";
    return {
        sourceKind,
        ...(input.writer ? { writer: input.writer } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.hook ? { hook: input.hook } : {}),
        confidence,
        ...(input.scope ? { scope: input.scope } : {}),
    };
}
function hashParts(parts) {
    const h = createHash("sha256");
    for (const part of parts)
        h.update(part).update("\0");
    return h.digest("hex");
}
