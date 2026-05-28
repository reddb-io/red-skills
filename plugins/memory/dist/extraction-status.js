import { readConfig } from "./config.js";
import { resolveProvider } from "./extract-conversation.js";
export async function buildMemoryExtractionStatus(store, rootDir, opts = {}) {
    const [config, nodes] = await Promise.all([readConfig(rootDir), store.listNodes()]);
    const facts = nodes.filter((node) => node.properties.confidence === "INFERRED").length;
    const inferred = {
        configured: false,
        available: false,
        mode: null,
        model: null,
        endpoint: null,
        egress: null,
        hook_stop_enabled: config?.hooks.stop === true,
        facts,
        error: undefined,
    };
    if (!config) {
        inferred.error = "memory is not initialized";
    }
    else if (config.mode !== "graph") {
        inferred.error = `memory is ${config.mode}; inferred extraction requires graph mode`;
    }
    else if (!config.provider) {
        inferred.error = "no AI provider configured for inferred extraction";
    }
    else {
        inferred.configured = true;
        try {
            const resolved = resolveProvider(config.provider);
            inferred.available = true;
            inferred.mode = resolved.mode;
            inferred.model = resolved.model;
            inferred.endpoint = resolved.endpoint;
            inferred.egress = resolved.egress;
        }
        catch (err) {
            inferred.error = err instanceof Error ? err.message : String(err);
        }
    }
    return {
        schema_version: "memory.extraction_status.v1",
        read_only: true,
        root: rootDir,
        generated_at: new Date(opts.now ?? Date.now()).toISOString(),
        deterministic: {
            markdown_entities: true,
            code_calls: true,
            code_type_uses: true,
            sql_schema_references: true,
            dev_workflow: true,
            structured_transcript: true,
        },
        inferred,
        recommended_next_actions: extractionActions(inferred),
    };
}
function extractionActions(status) {
    const actions = [];
    if (!status.configured) {
        actions.push("use `memory extract --local` for structured transcripts or configure `provider` for free-form inferred extraction");
    }
    if (status.configured && !status.available) {
        actions.push("fix the configured Memory AI provider before running `memory extract`");
    }
    if (status.available && !status.hook_stop_enabled) {
        actions.push("enable the Stop hook if you want session-end inferred extraction");
    }
    if (status.available && status.facts === 0) {
        actions.push("run `memory extract <transcript>` to seed inferred facts");
    }
    if (actions.length === 0)
        actions.push("Memory extraction paths are ready");
    return actions;
}
