import type { MemoryStore } from "../graph-store.js";

export async function operationStructuredContent(
  operationId: string,
  output: unknown,
  store: MemoryStore,
): Promise<Record<string, unknown>> {
  if (!isRecord(output)) return { operation_id: operationId };

  switch (operationId) {
    case "memory.ask": {
      const evidence = isRecord(output.evidence) ? output.evidence : {};
      const byConfidence = isRecord(evidence.byConfidence) ? evidence.byConfidence : {};
      const gapAnalysis = isRecord(output.gap_analysis) ? output.gap_analysis : {};
      return {
        operation_id: operationId,
        status: output.status,
        available: output.available,
        citations: arrayLength(output.citations),
        active_evidence: arrayLength(evidence.active),
        superseded_evidence: arrayLength(evidence.superseded),
        contradictions: arrayLength(evidence.contradictory),
        extracted_evidence: arrayLength(byConfidence.EXTRACTED),
        inferred_evidence: arrayLength(byConfidence.INFERRED),
        ambiguous_evidence: arrayLength(byConfidence.AMBIGUOUS),
        gap_status: gapAnalysis.status ?? null,
        gaps: arrayLength(gapAnalysis.gaps),
        next_actions: arrayLength(gapAnalysis.next_actions),
        cost_usd: isRecord(output.cost) ? output.cost.cost_usd ?? null : null,
        prompt_tokens: isRecord(output.cost) ? output.cost.prompt_tokens ?? null : null,
        completion_tokens: isRecord(output.cost) ? output.cost.completion_tokens ?? null : null,
        model: isRecord(output.cost) ? output.cost.model ?? null : null,
        provider: isRecord(output.cost) ? output.cost.provider ?? null : null,
      };
    }
    case "memory.claim-check":
      return {
        operation_id: operationId,
        status: output.status,
        citations: arrayLength(output.citations),
        active_evidence: arrayLength(
          isRecord(output.evidence) ? output.evidence.active : undefined,
        ),
        conflicting_evidence: arrayLength(
          isRecord(output.evidence) ? output.evidence.conflicting : undefined,
        ),
      };
    case "memory.governance": {
      const summary = isRecord(output.summary) ? output.summary : {};
      const tidy = isRecord(output.tidy_availability) ? output.tidy_availability : {};
      const tidyRecommendations = isRecord(output.tidy_recommendations)
        ? output.tidy_recommendations
        : {};
      const tidyRecommendationsSummary = isRecord(tidyRecommendations.summary)
        ? tidyRecommendations.summary
        : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        status: output.status,
        tidy_status: tidy.status ?? null,
        tidy_reason: tidy.reason ?? null,
        tidy_next_action: tidy.next_action ?? null,
        tidy_recommendations_status: tidyRecommendations.status ?? null,
        tidy_recommendations: tidyRecommendationsSummary.recommended_pairs ?? null,
        total_nodes: summary.total_nodes ?? null,
        missing_provenance: summary.missing_provenance ?? null,
        privacy_findings: summary.privacy_findings ?? null,
        lint_findings: summary.lint_findings ?? null,
        unresolved_contradictions: summary.unresolved_contradictions ?? null,
        superseded_nodes: summary.superseded_nodes ?? null,
        next_actions: arrayLength(output.recommended_next_actions),
      };
    }
    case "memory.governance-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      const tidy = isRecord(report.tidy_availability) ? report.tidy_availability : {};
      const tidyRecommendations = isRecord(report.tidy_recommendations)
        ? report.tidy_recommendations
        : {};
      const tidyRecommendationsSummary = isRecord(tidyRecommendations.summary)
        ? tidyRecommendations.summary
        : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: report.status,
        tidy_status: tidy.status ?? null,
        tidy_reason: tidy.reason ?? null,
        tidy_next_action: tidy.next_action ?? null,
        tidy_recommendations_status: tidyRecommendations.status ?? null,
        tidy_recommendations: tidyRecommendationsSummary.recommended_pairs ?? null,
        missing_provenance: summary.missing_provenance ?? null,
        privacy_findings: summary.privacy_findings ?? null,
        lint_findings: summary.lint_findings ?? null,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.handoff-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: report.status,
        returned_items: summary.returned_items ?? null,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.work-frontier": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        status: output.status,
        focus: output.focus,
        ready: summary.ready,
        blocked: summary.blocked,
        completed: summary.completed,
        markdown_bytes:
          typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
        read_only: output.read_only,
      };
    }
    case "memory.work-frontier-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: report.status,
        ready: summary.ready,
        blocked: summary.blocked,
        completed: summary.completed,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.decay": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        status: output.status,
        keep: summary.keep,
        review: summary.review,
        deprecate: summary.deprecate,
        expire: summary.expire,
        markdown_bytes:
          typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
      };
    }
    case "memory.decay-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: report.status,
        keep: summary.keep,
        review: summary.review,
        deprecate: summary.deprecate,
        expire: summary.expire,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.asset-inventory":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        total_assets: output.total_assets,
        total_bytes: output.total_bytes,
        kinds: arrayLength(output.kinds),
        warnings: arrayLength(output.warnings),
        read_only: output.read_only,
      };
    case "memory.asset-inventory-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        total_assets: report.total_assets,
        kinds: arrayLength(report.kinds),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.smart-search": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        recall_hits: summary.recall_hits ?? null,
        doc_hits: summary.doc_hits ?? null,
        asset_hits: summary.asset_hits ?? null,
        vector_hits: summary.vector_hits ?? null,
        vector_status: summary.vector_status ?? null,
        top_results: arrayLength(output.top_results),
        next_actions: arrayLength(output.recommended_next_actions),
      };
    }
    case "memory.smart-search-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        query: report.query,
        recall_hits: summary.recall_hits ?? null,
        doc_hits: summary.doc_hits ?? null,
        asset_hits: summary.asset_hits ?? null,
        vector_hits: summary.vector_hits ?? null,
        top_results: arrayLength(report.top_results),
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.doc-bundle":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        query: output.query,
        total_docs: output.total_docs,
        hits: arrayLength(output.hits),
        packs: arrayLength(output.packs),
        warnings: arrayLength(output.warnings),
        markdown_bytes:
          typeof output.markdown === "string"
            ? Buffer.byteLength(output.markdown, "utf8")
            : 0,
        read_only: output.read_only,
      };
    case "memory.doc-brief":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        query: output.query,
        status: output.status,
        citations: arrayLength(output.citations),
        gaps: arrayLength(output.gaps),
        next_actions: arrayLength(output.next_actions),
        markdown_bytes:
          typeof output.markdown === "string"
            ? Buffer.byteLength(output.markdown, "utf8")
            : 0,
        read_only: output.read_only,
      };
    case "memory.doc-brief-viewer": {
      const brief = isRecord(output.brief) ? output.brief : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        schema_version: brief.schema_version,
        query: brief.query,
        status: brief.status,
        citations: arrayLength(brief.citations),
        gaps: arrayLength(brief.gaps),
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
        read_only: brief.read_only,
      };
    }
    case "memory.doc-bundle-viewer": {
      const bundle = isRecord(output.bundle) ? output.bundle : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        schema_version: bundle.schema_version,
        query: bundle.query,
        hits: arrayLength(bundle.hits),
        packs: arrayLength(bundle.packs),
        warnings: arrayLength(bundle.warnings),
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
        read_only: bundle.read_only,
      };
    }
    case "memory.capability-catalog": {
      const summary = isRecord(output.summary) ? output.summary : {};
      const runtime = isRecord(output.runtime) ? output.runtime : {};
      const stats = isRecord(runtime.stats) ? runtime.stats : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        total: summary.total,
        ready: summary.ready,
        degraded: summary.degraded,
        not_configured: summary.not_configured,
        red_db_backed: summary.red_db_backed,
        categories: arrayLength(output.categories),
        nodes: stats.nodes,
        edges: stats.edges,
        read_only: output.read_only,
      };
    }
    case "memory.references-radar": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        references: summary.references,
        total_relevant_capabilities: summary.total_relevant_capabilities,
        degraded_or_not_configured: summary.degraded_or_not_configured,
        recommended_next_actions: arrayLength(output.recommended_next_actions),
      };
    }
    case "memory.communities": {
      const stats = await store.stats();
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        communities: arrayLength(output.communities),
        assignments: arrayLength(output.assignments),
        node_analytics: arrayLength(output.node_analytics),
        inter_community_edges: arrayLength(output.inter_community_edges),
        graph_hash: output.graph_hash,
        cached: output.cached,
        nodes: stats.nodes,
        edges: stats.edges,
      };
    }
    case "memory.community-digest": {
      const provider = isRecord(output.provider) ? output.provider : {};
      const digests = Array.isArray(output.digests) ? output.digests : [];
      const narrativeSummaries = digests.filter(
        (digest) =>
          isRecord(digest) &&
          typeof digest.narrative_summary === "string" &&
          digest.narrative_summary.length > 0,
      ).length;
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        community_count: output.community_count,
        digests: digests.length,
        narrative_summaries: narrativeSummaries,
        provider_status: provider.status ?? null,
        provider_mode: provider.mode ?? null,
        provider_model: provider.model ?? null,
        provider_error: provider.error ?? null,
        graph_hash: output.graph_hash,
        cached: output.cached,
      };
    }
    case "memory.global-search": {
      const source = isRecord(output.generated_from) ? output.generated_from : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        surface: output.surface,
        query: output.query,
        total_hits: output.total_hits,
        evidence: arrayLength(output.evidence),
        source_operation: source.operation_id ?? null,
        graph_hash: source.graph_hash ?? null,
        cached: source.cached ?? null,
      };
    }
    case "memory.communities-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        communities: arrayLength(report.communities),
        assignments: arrayLength(report.assignments),
        node_analytics: arrayLength(report.node_analytics),
        inter_community_edges: arrayLength(report.inter_community_edges),
        graph_hash: report.graph_hash,
        cached: report.cached,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.context-pack":
      return {
        operation_id: operationId,
        status: output.status,
        entries: arrayLength(output.entries),
        warnings: arrayLength(output.warnings),
        omitted_entries: output.omittedEntries,
      };
    case "memory.context-pack-viewer": {
      const pack = isRecord(output.pack) ? output.pack : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: pack.status,
        entries: arrayLength(pack.entries),
        warnings: arrayLength(pack.warnings),
        omitted_entries: pack.omittedEntries,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.dashboard": {
      const dashboard = isRecord(output.dashboard) ? output.dashboard : {};
      const stats = isRecord(dashboard.stats) ? dashboard.stats : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        state: dashboard.state,
        nodes: stats.nodes,
        edges: stats.edges,
        docs: stats.docs,
        warnings: arrayLength(dashboard.warnings),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.doc-read":
      return {
        operation_id: operationId,
        found: output.found,
        matched_by: output.matched_by,
        rid: output.rid,
        path: output.path,
        body_bytes: output.body_bytes,
        returned_bytes: output.returned_bytes,
        truncated: output.truncated,
      };
    case "memory.doc-evidence-pack": {
      const doc = isRecord(output.doc) ? output.doc : {};
      const related = isRecord(output.related) ? output.related : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        found: output.found,
        matched_by: output.matched_by,
        path: doc.path,
        rid: doc.rid,
        references: arrayLength(related.references),
        related_docs: arrayLength(related.related_docs),
        warnings: arrayLength(output.warnings),
        markdown_bytes:
          typeof output.markdown === "string"
            ? Buffer.byteLength(output.markdown, "utf8")
            : 0,
        read_only: output.read_only,
      };
    }
    case "memory.doc-evidence-pack-viewer": {
      const pack = isRecord(output.pack) ? output.pack : {};
      const doc = isRecord(pack.doc) ? pack.doc : {};
      const related = isRecord(pack.related) ? pack.related : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        schema_version: pack.schema_version,
        found: pack.found,
        path: doc.path,
        rid: doc.rid,
        references: arrayLength(related.references),
        related_docs: arrayLength(related.related_docs),
        warnings: arrayLength(pack.warnings),
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
        read_only: pack.read_only,
      };
    }
    case "memory.doc-backlinks":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        found: output.found,
        matched_by: output.matched_by,
        references: arrayLength(output.references),
        docs: arrayLength(output.docs),
        warnings: arrayLength(output.warnings),
        read_only: output.read_only,
      };
    case "memory.doc-backlinks-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        found: report.found,
        references: arrayLength(report.references),
        docs: arrayLength(report.docs),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.doc-related":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        found: output.found,
        matched_by: output.matched_by,
        target: isRecord(output.target) ? output.target.path ?? output.target.label : undefined,
        references: arrayLength(output.references),
        related_docs: arrayLength(output.related_docs),
        warnings: arrayLength(output.warnings),
        read_only: output.read_only,
      };
    case "memory.doc-related-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        found: report.found,
        references: arrayLength(report.references),
        related_docs: arrayLength(report.related_docs),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.doc-coverage":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        total_docs: output.total_docs,
        grounded_docs: output.grounded_docs,
        ungrounded_docs: output.ungrounded_docs,
        docs_with_references: output.docs_with_references,
        total_references: output.total_references,
        vector_overall: isRecord(output.vector) ? output.vector.overall : undefined,
        warnings: arrayLength(output.warnings),
        read_only: output.read_only,
      };
    case "memory.doc-coverage-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        total_docs: report.total_docs,
        grounded_docs: report.grounded_docs,
        warnings: arrayLength(report.warnings),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.doc-reference-graph":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        total_docs: output.total_docs,
        grounded_docs: output.grounded_docs,
        reference_nodes: output.reference_nodes,
        reference_edges: output.reference_edges,
        top_references: arrayLength(output.top_references),
        warnings: arrayLength(output.warnings),
        read_only: output.read_only,
      };
    case "memory.doc-reference-graph-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        total_docs: report.total_docs,
        reference_nodes: report.reference_nodes,
        reference_edges: report.reference_edges,
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.doc-search":
      return {
        operation_id: operationId,
        query: output.query,
        total_docs: output.total_docs,
        hits: arrayLength(output.hits),
      };
    case "memory.doc-search-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        query: report.query,
        total_docs: report.total_docs,
        hits: arrayLength(report.hits),
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.extraction-status": {
      const deterministic = isRecord(output.deterministic) ? output.deterministic : {};
      const inferred = isRecord(output.inferred) ? output.inferred : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        deterministic_ready: Object.values(deterministic).filter(Boolean).length,
        inferred_configured: inferred.configured ?? null,
        inferred_available: inferred.available ?? null,
        inferred_facts: inferred.facts ?? null,
        hook_stop_enabled: inferred.hook_stop_enabled ?? null,
        next_actions: arrayLength(output.recommended_next_actions),
      };
    }
    case "memory.extraction-status-viewer": {
      const status = isRecord(output.status) ? output.status : {};
      const deterministic = isRecord(status.deterministic) ? status.deterministic : {};
      const inferred = isRecord(status.inferred) ? status.inferred : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        deterministic_ready: Object.values(deterministic).filter(Boolean).length,
        inferred_available: inferred.available ?? null,
        inferred_facts: inferred.facts ?? null,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.health":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        state: output.state,
        stats: output.stats,
        stale: isRecord(output.stale) ? output.stale.stale : undefined,
      };
    case "memory.health-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        state: report.state,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.handoff": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        status: output.status,
        focus: output.focus,
        returned_items: summary.returned_items,
        active_work: summary.active_work,
        decisions: summary.decisions,
        validations: summary.validations,
        risks: summary.risks,
        context: summary.context,
        markdown_bytes:
          typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
        read_only: output.read_only,
      };
    }
    case "memory.hook-coverage": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        mode: output.mode,
        config_found: output.config_found,
        total_events: summary.total_events,
        wired_events: summary.wired_events,
        enabled_events: summary.enabled_events,
        gaps: arrayLength(output.gaps),
        read_only: output.read_only,
      };
    }
    case "memory.hook-coverage-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        mode: report.mode,
        effective_events: summary.effective_events,
        total_events: summary.total_events,
        actionable_gaps: summary.actionable_gaps,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.learning-debt":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        status: output.status,
        summary: output.summary,
      };
    case "memory.learning-debt-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: report.status,
        summary: report.summary,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.layers": {
      const summary = isRecord(output.summary) ? output.summary : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        total_layers: summary.total_layers,
        ready_layers: summary.ready_layers,
        red_db_backed_layers: summary.red_db_backed_layers,
        layers: arrayLength(output.layers),
        reference_alignment: arrayLength(output.reference_alignment),
        read_only: output.read_only,
      };
    }
    case "memory.layers-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        total_layers: summary.total_layers,
        ready_layers: summary.ready_layers,
        red_db_backed_layers: summary.red_db_backed_layers,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.onboarding-map":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        status: output.status,
        summary: output.summary,
        warnings: arrayLength(output.warnings),
      };
    case "memory.onboarding-map-viewer": {
      const map = isRecord(output.map) ? output.map : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        status: map.status,
        summary: map.summary,
        warnings: arrayLength(map.warnings),
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.confidence": {
      const node = isRecord(output.node) ? output.node : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        node_rid: node.rid,
        confidence: output.confidence,
      };
    }
    case "memory.federation":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        query: output.query,
        roots_queried: output.roots_queried,
        result_count: arrayLength(output.results),
      };
    case "memory.path-explain":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        reachable: output.reachable,
        hop_count: output.hop_count,
        path_nodes: arrayLength(output.path),
        path_edges: arrayLength(output.edges),
        markdown_bytes:
          typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
        read_only: output.read_only,
      };
    case "memory.path-explain-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        reachable: report.reachable,
        hop_count: report.hop_count,
        path_nodes: arrayLength(report.path),
        path_edges: arrayLength(report.edges),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.lint":
      return {
        operation_id: operationId,
        status: output.status,
        findings: arrayLength(output.findings),
        rule_suggestions: arrayLength(output.ruleSuggestions),
        total_memories: output.totalMemories,
        read_only: output.readOnly,
      };
    case "memory.privacy-scan":
      return {
        operation_id: operationId,
        status: output.status,
        findings: arrayLength(output.findings),
        total_memories: output.totalMemories,
        read_only: output.readOnly,
        mutated: output.mutated,
      };
    case "memory.pre-pr-review":
      return {
        operation_id: operationId,
        changed_files: arrayLength(output.changedFiles),
        impacted_concepts: sectionItemCount(output.impactedConcepts),
        related_decisions: sectionItemCount(output.relatedDecisions),
        known_failures: sectionItemCount(output.knownFailures),
        suggested_validations: sectionItemCount(output.suggestedValidations),
        risks: sectionItemCount(output.risks),
        evidence: arrayLength(output.evidence),
        missing_evidence: arrayLength(output.missingEvidence),
        read_only: output.readOnly,
      };
    case "memory.pre-pr-review-viewer": {
      const review = isRecord(output.review) ? output.review : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        changed_files: arrayLength(review.changedFiles),
        evidence: arrayLength(review.evidence),
        risks: sectionItemCount(review.risks),
        missing_evidence: arrayLength(review.missingEvidence),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.provenance":
      return {
        operation_id: operationId,
        rid: isRecord(output.node) ? output.node.rid : undefined,
        label: isRecord(output.node) ? output.node.label : undefined,
        missing: isRecord(output.provenance) ? output.provenance.missing : undefined,
      };
    case "memory.readiness":
      return {
        operation_id: operationId,
        status: output.status,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        active_evidence: arrayLength(
          isRecord(output.evidence) ? output.evidence.active : undefined,
        ),
        next_actions: arrayLength(output.next_actions),
      };
    case "memory.readiness-viewer": {
      const envelope = isRecord(output.envelope) ? output.envelope : {};
      const evidence = isRecord(envelope.evidence) ? envelope.evidence : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        readiness_status: envelope.status,
        active_evidence: arrayLength(evidence.active),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.map-context": {
      const diagnostics = isRecord(output.diagnostics) ? output.diagnostics : {};
      const traversal = isRecord(output.traversal) ? output.traversal : {};
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        query: output.query,
        mode: traversal.mode,
        depth: traversal.depth,
        context_filters: arrayLength(traversal.context_filters),
        seeds: arrayLength(output.seeds),
        nodes: arrayLength(output.nodes),
        edges: arrayLength(output.edges),
        truncated: diagnostics.truncated,
        omitted_nodes: diagnostics.omitted_nodes,
      };
    }
    case "memory.routing-guide":
      return {
        operation_id: operationId,
        schema_version: output.schemaVersion,
        agent: output.agent,
        supported_agents: arrayLength(output.supportedAgents),
        transports: isRecord(output.integration)
          ? arrayLength(output.integration.transports)
          : undefined,
        target_files: arrayLength(output.targetFiles),
        mcp_tools: arrayLength(output.mcpTools),
        config_snippets: isRecord(output.integration)
          ? arrayLength(output.integration.configSnippets)
          : undefined,
        rules: arrayLength(output.rules),
        safety_notes: arrayLength(output.safetyNotes),
        snippet_bytes:
          typeof output.installSnippet === "string"
            ? Buffer.byteLength(output.installSnippet, "utf8")
            : 0,
      };
    case "memory.routing-guide-viewer": {
      const guide = isRecord(output.guide) ? output.guide : {};
      const integration = isRecord(guide.integration) ? guide.integration : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        agent: guide.agent,
        transports: arrayLength(integration.transports),
        target_files: arrayLength(guide.targetFiles),
        mcp_tools: arrayLength(guide.mcpTools),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.agent-integration-status":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        mode: output.mode,
        agents: isRecord(output.summary) ? output.summary.agents : undefined,
        ready: isRecord(output.summary) ? output.summary.ready : undefined,
        partial: isRecord(output.summary) ? output.summary.partial : undefined,
        missing: isRecord(output.summary) ? output.summary.missing : undefined,
        next_actions: arrayLength(output.recommended_next_actions),
      };
    case "memory.agent-integration-status-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      const summary = isRecord(report.summary) ? report.summary : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        agents: summary.agents,
        ready: summary.ready,
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.skill-recommendations":
      return {
        operation_id: operationId,
        status: output.status,
        recommendations: arrayLength(output.recommendations),
        missing_evidence: arrayLength(output.missingEvidence),
      };
    case "memory.structural-impact":
      return {
        operation_id: operationId,
        imports: arrayLength(output.imports),
        imported_by: arrayLength(output.importedBy),
        calls: arrayLength(output.calls),
        called_by: arrayLength(output.calledBy),
        uses_types: arrayLength(output.usesTypes),
        used_by_types: arrayLength(output.usedByTypes),
        defines: arrayLength(output.defines),
        defined_in: isRecord(output.definedIn) ? output.definedIn.label : null,
      };
    case "memory.structural-impact-viewer": {
      const impact = isRecord(output.impact) ? output.impact : {};
      return {
        operation_id: operationId,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        imports: arrayLength(impact.imports),
        calls: arrayLength(impact.calls),
        uses_types: arrayLength(impact.usesTypes),
        html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.vector-status":
      return {
        operation_id: operationId,
        schema_version: output.schema_version,
        read_only: output.read_only,
        overall: output.overall,
        total: output.total,
        ready: output.ready,
        stale: output.stale,
        unavailable: output.unavailable,
        failed: output.failed,
      };
    case "memory.vector-status-viewer": {
      const report = isRecord(output.report) ? output.report : {};
      return {
        operation_id: operationId,
        contract: isRecord(output.contract) ? output.contract.version : undefined,
        consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
        overall: report.overall,
        total: report.total,
        ready: report.ready,
        stale: report.stale,
        unavailable: report.unavailable,
        failed: report.failed,
        html_bytes:
          typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
      };
    }
    case "memory.vector-search":
      return {
        operation_id: operationId,
        status: output.status,
        query: output.query,
        limit: output.limit,
        hits: arrayLength(output.hits),
        error: output.error,
        read_only: output.read_only,
      };
    default:
      return { operation_id: operationId };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function sectionItemCount(value: unknown): number {
  return isRecord(value) ? arrayLength(value.items) : 0;
}

