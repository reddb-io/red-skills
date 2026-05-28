import { readFile } from "node:fs/promises";
import { join } from "node:path";
/* ----------------------------------------------------------------------------
 * Deterministic seeded RNG (mulberry32). The workload itself — which sessions
 * and which keys each iteration reads — is byte-deterministic across runs;
 * only the measured wall-clock times vary, within the tolerance documented in
 * `bench/latency/README.md`.
 * --------------------------------------------------------------------------*/
function mulberry32(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function buildPayload(id, chars) {
    const base = `${id}::payload::`;
    const fill = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = base;
    while (s.length < chars)
        s += fill;
    return s.slice(0, chars);
}
function seedStores(cfg) {
    const ours = { sessions: new Map(), longTerm: new Map(), longTermIds: [] };
    const ams = { sessions: new Map(), longTerm: new Map(), longTermIds: [] };
    for (let s = 0; s < cfg.sessions; s++) {
        const sid = `sess-${s.toString().padStart(4, "0")}`;
        const events = [];
        for (let e = 0; e < cfg.events_per_session; e++) {
            events.push(buildPayload(`${sid}:ev:${e}`, cfg.payload_chars));
        }
        ours.sessions.set(sid, events);
        // AMS path: events arrive over the wire as a single serialised JSON blob
        // per session — same shape redis HGET/JSON.GET would land.
        ams.sessions.set(sid, Buffer.from(JSON.stringify(events), "utf8"));
    }
    for (let n = 0; n < cfg.long_term_nodes; n++) {
        const nid = `node-${n.toString().padStart(5, "0")}`;
        const text = buildPayload(nid, cfg.payload_chars);
        ours.longTerm.set(nid, text);
        ours.longTermIds.push(nid);
        ams.longTerm.set(nid, Buffer.from(JSON.stringify({ id: nid, text }), "utf8"));
        ams.longTermIds.push(nid);
    }
    return { ours, ams };
}
/* ----------------------------------------------------------------------------
 * Op implementations.
 *
 * Our path: direct Map lookup + (for recall) a small linear scan over the
 * working set — mirrors the L1/L2 cached hot-read path that an in-process
 * RedDB-backed store offers.
 *
 * AMS reference: every read pays a JSON.parse over the serialised payload
 * (what a real Redis client does on every response) plus, for the recall
 * variants, a fan-out over multiple keys (each parsed individually — Redis
 * has no graph-side fan-out, so the client does the join).
 *
 * Neither path sleeps; both do only real CPU work. That keeps the gap
 * honest — we are not modelling network RTT, only the cost the AMS-on-Redis
 * architecture cannot avoid even on localhost.
 * --------------------------------------------------------------------------*/
function opOursWorkingGet(store, sid) {
    const events = store.sessions.get(sid);
    return events ? events.length : 0;
}
function opAmsWorkingGet(store, sid) {
    const buf = store.sessions.get(sid);
    if (!buf)
        return 0;
    const arr = JSON.parse(buf.toString("utf8"));
    return arr.length;
}
function opOursSessionRecall(store, sid, k) {
    const events = store.sessions.get(sid);
    if (!events)
        return 0;
    let hits = 0;
    const top = Math.min(k, events.length);
    for (let i = 0; i < top; i++) {
        // mirror the recall composer's per-event scoring touch.
        if (events[i].length > 0)
            hits += 1;
    }
    return hits;
}
function opAmsSessionRecall(store, sid, k) {
    const buf = store.sessions.get(sid);
    if (!buf)
        return 0;
    const arr = JSON.parse(buf.toString("utf8"));
    let hits = 0;
    const top = Math.min(k, arr.length);
    for (let i = 0; i < top; i++) {
        if (arr[i].length > 0)
            hits += 1;
    }
    return hits;
}
function opOursLongTermRecall(store, ids) {
    let hits = 0;
    for (const id of ids) {
        const v = store.longTerm.get(id);
        if (v && v.length > 0)
            hits += 1;
    }
    return hits;
}
function opAmsLongTermRecall(store, ids) {
    // Redis has no native graph fan-out; the client issues N gets and parses N
    // payloads. Model exactly that.
    let hits = 0;
    for (const id of ids) {
        const buf = store.longTerm.get(id);
        if (!buf)
            continue;
        const node = JSON.parse(buf.toString("utf8"));
        if (node.text.length > 0)
            hits += 1;
    }
    return hits;
}
/* ----------------------------------------------------------------------------
 * Percentile arithmetic.
 * --------------------------------------------------------------------------*/
export function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0)
        return 0;
    if (p <= 0)
        return sortedAsc[0];
    if (p >= 1)
        return sortedAsc[sortedAsc.length - 1];
    const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
    return sortedAsc[idx];
}
export function statsFromSamplesNs(samplesNs) {
    const us = new Array(samplesNs.length);
    let sum = 0;
    for (let i = 0; i < samplesNs.length; i++) {
        const v = Number(samplesNs[i]) / 1000;
        us[i] = v;
        sum += v;
    }
    us.sort((a, b) => a - b);
    return {
        count: us.length,
        min_us: round3(us[0] ?? 0),
        p50_us: round3(percentile(us, 0.5)),
        p95_us: round3(percentile(us, 0.95)),
        p99_us: round3(percentile(us, 0.99)),
        p999_us: round3(percentile(us, 0.999)),
        max_us: round3(us[us.length - 1] ?? 0),
        mean_us: round3(sum / Math.max(us.length, 1)),
    };
}
function round3(n) {
    return Math.round(n * 1000) / 1000;
}
/* ----------------------------------------------------------------------------
 * Bench runner
 * --------------------------------------------------------------------------*/
export const DEFAULT_WORKLOAD = {
    sessions: 32,
    events_per_session: 24,
    long_term_nodes: 512,
    payload_chars: 256,
    iterations: 5000,
    warmup: 500,
    seed: 0xa11ce,
    op_classes: ["working-get", "session-recall", "long-term-recall"],
};
export async function runBenchLatency(opts = {}) {
    const cfg = { ...DEFAULT_WORKLOAD, ...(opts.workload ?? {}) };
    const { ours, ams } = seedStores(cfg);
    const rng = mulberry32(cfg.seed);
    // Pre-roll the deterministic key sequence so timing measurements do not
    // include RNG cost.
    const sessionKeys = new Array(cfg.iterations + cfg.warmup);
    for (let i = 0; i < sessionKeys.length; i++) {
        const idx = Math.floor(rng() * cfg.sessions);
        sessionKeys[i] = `sess-${idx.toString().padStart(4, "0")}`;
    }
    // Recall fan-out: 8 long-term ids per op, drawn deterministically.
    const FANOUT = 8;
    const longTermFans = new Array(cfg.iterations + cfg.warmup);
    for (let i = 0; i < longTermFans.length; i++) {
        const ids = new Array(FANOUT);
        for (let j = 0; j < FANOUT; j++) {
            const idx = Math.floor(rng() * cfg.long_term_nodes);
            ids[j] = `node-${idx.toString().padStart(5, "0")}`;
        }
        longTermFans[i] = ids;
    }
    const SESSION_RECALL_K = 16;
    const results = [];
    for (const op of cfg.op_classes) {
        const oursSamples = new BigInt64Array(cfg.iterations);
        const amsSamples = new BigInt64Array(cfg.iterations);
        // Warm both paths first so JIT, hidden-class shapes, and inline caches
        // are stable before timing starts. p50/p99 want a hot cache.
        runOurs(op, ours, sessionKeys, longTermFans, SESSION_RECALL_K, 0, cfg.warmup, null);
        runAms(op, ams, sessionKeys, longTermFans, SESSION_RECALL_K, 0, cfg.warmup, null);
        runOurs(op, ours, sessionKeys, longTermFans, SESSION_RECALL_K, cfg.warmup, cfg.iterations, oursSamples);
        runAms(op, ams, sessionKeys, longTermFans, SESSION_RECALL_K, cfg.warmup, cfg.iterations, amsSamples);
        const oursStats = statsFromSamplesNs(oursSamples);
        const amsStats = statsFromSamplesNs(amsSamples);
        results.push({
            op,
            ours: oursStats,
            ams_reference: amsStats,
            delta: {
                p50_us: round3(amsStats.p50_us - oursStats.p50_us),
                p95_us: round3(amsStats.p95_us - oursStats.p95_us),
                p99_us: round3(amsStats.p99_us - oursStats.p99_us),
                p999_us: round3(amsStats.p999_us - oursStats.p999_us),
            },
            speedup: {
                p50: speedup(amsStats.p50_us, oursStats.p50_us),
                p95: speedup(amsStats.p95_us, oursStats.p95_us),
                p99: speedup(amsStats.p99_us, oursStats.p99_us),
                p999: speedup(amsStats.p999_us, oursStats.p999_us),
            },
        });
    }
    const now = (opts.now ?? (() => new Date()))();
    return {
        schema_version: "memory.bench.latency.v1",
        generated_at: now.toISOString(),
        workload: cfg,
        results,
    };
}
function speedup(ams, ours) {
    if (ours <= 0)
        return 0;
    return Math.round((ams / ours) * 100) / 100;
}
function runOurs(op, store, sessionKeys, longTermFans, k, startOffset, count, samples) {
    for (let i = 0; i < count; i++) {
        const idx = startOffset + i;
        const t0 = process.hrtime.bigint();
        if (op === "working-get") {
            opOursWorkingGet(store, sessionKeys[idx]);
        }
        else if (op === "session-recall") {
            opOursSessionRecall(store, sessionKeys[idx], k);
        }
        else {
            opOursLongTermRecall(store, longTermFans[idx]);
        }
        const t1 = process.hrtime.bigint();
        if (samples)
            samples[i] = t1 - t0;
    }
}
function runAms(op, store, sessionKeys, longTermFans, k, startOffset, count, samples) {
    for (let i = 0; i < count; i++) {
        const idx = startOffset + i;
        const t0 = process.hrtime.bigint();
        if (op === "working-get") {
            opAmsWorkingGet(store, sessionKeys[idx]);
        }
        else if (op === "session-recall") {
            opAmsSessionRecall(store, sessionKeys[idx], k);
        }
        else {
            opAmsLongTermRecall(store, longTermFans[idx]);
        }
        const t1 = process.hrtime.bigint();
        if (samples)
            samples[i] = t1 - t0;
    }
}
/* ----------------------------------------------------------------------------
 * Markdown report
 * --------------------------------------------------------------------------*/
export function formatLatencyReport(report) {
    const lines = [];
    lines.push(`# memory bench latency — ${report.generated_at.slice(0, 10)}`);
    lines.push("");
    lines.push(`Workload: ${report.workload.sessions} sessions × ${report.workload.events_per_session} events, ${report.workload.long_term_nodes} long-term nodes, ${report.workload.payload_chars}-char payloads, seed=0x${report.workload.seed.toString(16)}, ${report.workload.iterations} iters (+${report.workload.warmup} warmup). Reference baseline models AMS-on-Redis hot reads (JSON parse per response, client-side fan-out for graph hops); both paths do only real CPU work, no artificial sleeps. See \`bench/latency/README.md\`.`);
    lines.push("");
    lines.push("| op | strategy | p50 µs | p95 µs | p99 µs | p99.9 µs | mean µs |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const r of report.results) {
        lines.push(`| ${r.op} | ours | ${fmt(r.ours.p50_us)} | ${fmt(r.ours.p95_us)} | ${fmt(r.ours.p99_us)} | ${fmt(r.ours.p999_us)} | ${fmt(r.ours.mean_us)} |`);
        lines.push(`| ${r.op} | ams_reference | ${fmt(r.ams_reference.p50_us)} | ${fmt(r.ams_reference.p95_us)} | ${fmt(r.ams_reference.p99_us)} | ${fmt(r.ams_reference.p999_us)} | ${fmt(r.ams_reference.mean_us)} |`);
        lines.push(`| ${r.op} | Δ (ams − ours) | ${fmt(r.delta.p50_us)} | ${fmt(r.delta.p95_us)} | ${fmt(r.delta.p99_us)} | ${fmt(r.delta.p999_us)} | — |`);
        lines.push(`| ${r.op} | speedup × | ${r.speedup.p50.toFixed(2)} | ${r.speedup.p95.toFixed(2)} | ${r.speedup.p99.toFixed(2)} | ${r.speedup.p999.toFixed(2)} | — |`);
    }
    lines.push("");
    lines.push("## Reproducibility");
    lines.push("");
    lines.push("The workload (session/key access sequence) is byte-deterministic across runs (seeded mulberry32, fixed warmup + iteration counts). Measured wall-clock percentiles vary with host noise; the test suite asserts the architectural invariant (`p99(ams) >= p99(ours)`) rather than absolute numbers. Typical run-to-run drift on a quiet developer laptop is within ±20% at p50 and ±50% at p99.9 — re-run several times when comparing reports.");
    lines.push("");
    return lines.join("\n");
}
function fmt(n) {
    return n.toFixed(3);
}
/* ----------------------------------------------------------------------------
 * Workload override loader (optional). Lets the bench/latency/README pin a
 * canonical `workload.json` that ops can adjust without code changes.
 * --------------------------------------------------------------------------*/
export async function loadWorkloadOverrides(dir) {
    try {
        const raw = await readFile(join(dir, "workload.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("workload.json must be a JSON object");
        }
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return {};
        throw err;
    }
}
