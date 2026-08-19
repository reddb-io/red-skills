export function searchConsoleScript(): string {
  return `(() => {
  const form = document.getElementById("memory-search-form");
  const input = document.getElementById("memory-search-query");
  const viewerLink = document.getElementById("memory-smart-search-link");
  const status = document.getElementById("memory-search-status");
  const summary = document.getElementById("memory-search-summary");
  const results = document.getElementById("memory-search-results");
  const actions = document.getElementById("memory-search-actions");
  if (!form || !input || !viewerLink || !status || !summary || !results || !actions) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(input.value || "").trim();
    viewerLink.setAttribute("href", "/search?query=" + encodeURIComponent(query || "memory"));
    summary.replaceChildren();
    results.replaceChildren();
    actions.replaceChildren();
    if (!query) {
      status.textContent = "Enter a query.";
      return;
    }
    status.textContent = "Searching...";
    try {
      const response = await fetch("/api/search?query=" + encodeURIComponent(query) + "&limit=5", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      const hits = Array.isArray(body.top_results) ? body.top_results : [];
      const counts = body.summary || {};
      status.textContent = hits.length + " fused result(s).";
      const summaryItem = document.createElement("li");
      summaryItem.textContent =
        "recall=" + String(counts.recall_hits ?? 0) +
        " docs=" + String(counts.doc_hits ?? 0) +
        " assets=" + String(counts.asset_hits ?? 0) +
        " vectors=" + String(counts.vector_hits ?? 0) +
        " (" + String(counts.vector_status ?? "unknown") + ")";
      summary.append(summaryItem);
      for (const hit of hits) {
        const item = document.createElement("li");
        item.className = "result";
        const rank = document.createElement("span");
        rank.className = "pill";
        rank.textContent = "#" + String(hit.rank ?? "?");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(hit.title ?? hit.id ?? "Untitled result");
        const meta = document.createElement("p");
        meta.className = "meta";
        const ref = hit.ref || {};
        const refText = ref.path || ref.label || (ref.rid == null ? "" : "rid:" + String(ref.rid));
        meta.textContent = String(hit.kind ?? "result") + " - " + (Array.isArray(hit.sources) ? hit.sources.join("+") : "unknown") + (refText ? " - " + String(refText) : "");
        const excerpt = document.createElement("p");
        excerpt.textContent = String(hit.excerpt ?? "");
        content.append(title, meta, excerpt);
        item.append(rank, content);
        results.append(item);
      }
      const nextActions = Array.isArray(body.recommended_next_actions) ? body.recommended_next_actions : [];
      for (const action of nextActions) {
        const item = document.createElement("li");
        item.textContent = String(action);
        actions.append(item);
      }
    } catch (err) {
      status.textContent = "Search unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function docsExplorerScript(): string {
  return `(() => {
  const form = document.getElementById("memory-docs-form");
  const input = document.getElementById("memory-docs-query");
  const status = document.getElementById("memory-docs-status");
  const results = document.getElementById("memory-docs-results");
  const body = document.getElementById("memory-docs-body");
  const evidencePack = document.getElementById("memory-docs-evidence-pack");
  const relatedResults = document.getElementById("memory-docs-related-results");
  const searchLink = document.getElementById("memory-docs-search-link");
  const briefButton = document.getElementById("memory-docs-brief-button");
  const briefLink = document.getElementById("memory-docs-brief-link");
  const bundleLink = document.getElementById("memory-docs-bundle-link");
  const backlinksForm = document.getElementById("memory-docs-backlinks-form");
  const backlinksInput = document.getElementById("memory-docs-backlinks-query");
  const backlinksStatus = document.getElementById("memory-docs-backlinks-status");
  const backlinksResults = document.getElementById("memory-docs-backlinks-results");
  if (!form || !input || !status || !results || !body || !evidencePack || !relatedResults || !searchLink || !briefButton || !briefLink || !bundleLink || !backlinksForm || !backlinksInput || !backlinksStatus || !backlinksResults) return;
  async function readDoc(rid) {
    body.textContent = "Loading doc...";
    const response = await fetch("/api/docs/read?rid=" + encodeURIComponent(String(rid)) + "&max_bytes=8000", {
      headers: { "accept": "application/json" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const doc = await response.json();
    body.textContent = doc.found ? String(doc.body || "") : "Indexed doc not found.";
  }
  async function loadEvidencePack(rid) {
    evidencePack.textContent = "Loading evidence pack...";
    const response = await fetch("/api/docs/evidence-pack?rid=" + encodeURIComponent(String(rid)) + "&max_bytes=8000", {
      headers: { "accept": "application/json" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const pack = await response.json();
    evidencePack.textContent = pack.found ? String(pack.markdown || "") : "Evidence pack not found.";
  }
  async function loadRelated(rid) {
    relatedResults.replaceChildren();
    const response = await fetch("/api/docs/related?rid=" + encodeURIComponent(String(rid)), {
      headers: { "accept": "application/json" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const report = await response.json();
    const refs = Array.isArray(report.references) ? report.references.slice(0, 5) : [];
    const docs = Array.isArray(report.related_docs) ? report.related_docs.slice(0, 5) : [];
    const summary = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = "Related docs";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = refs.length + " reference(s) shown, " + docs.length + " related doc(s) shown.";
    summary.append(title, meta);
    relatedResults.append(summary);
    for (const ref of refs) {
      const item = document.createElement("li");
      item.textContent = "Reference: " + String(ref.title || ref.label || "Referenced node");
      relatedResults.append(item);
    }
    for (const doc of docs) {
      const item = document.createElement("li");
      item.textContent = "Related: " + String(doc.path || doc.title || "Doc") + " (" + String(doc.shared_references ?? 0) + " shared)";
      relatedResults.append(item);
    }
  }
  briefButton.addEventListener("click", async () => {
    const query = String(input.value || "").trim();
    if (!query) {
      evidencePack.textContent = "Enter a docs query before generating a brief.";
      return;
    }
    evidencePack.textContent = "Generating docs brief...";
    try {
      const response = await fetch("/api/docs/brief?query=" + encodeURIComponent(query) + "&limit=3&max_bytes=8000", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const brief = await response.json();
      evidencePack.textContent = String(brief.markdown || "");
    } catch (err) {
      evidencePack.textContent = "Docs brief unavailable here; open the Workbench through memory serve.";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(input.value || "").trim();
    results.replaceChildren();
    if (!query) {
      status.textContent = "Enter a docs query.";
      return;
    }
    searchLink.setAttribute("href", "/docs/search?query=" + encodeURIComponent(query) + "&limit=10");
    briefLink.setAttribute("href", "/docs/brief?query=" + encodeURIComponent(query) + "&limit=3&max_bytes=8000");
    bundleLink.setAttribute("href", "/docs/bundle?query=" + encodeURIComponent(query) + "&limit=3&max_bytes=8000");
    status.textContent = "Searching docs...";
    try {
      const response = await fetch("/api/docs/search?query=" + encodeURIComponent(query) + "&limit=5", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const hits = Array.isArray(report.hits) ? report.hits : [];
      status.textContent = hits.length + " doc result(s).";
      for (const hit of hits) {
        const item = document.createElement("li");
        item.className = "result";
        const read = document.createElement("button");
        read.type = "button";
        read.textContent = "Read";
        read.addEventListener("click", () => {
          readDoc(hit.rid).catch(() => {
            body.textContent = "Doc read unavailable here; open the Workbench through memory serve.";
          });
        });
        const pack = document.createElement("button");
        pack.type = "button";
        pack.textContent = "Pack";
        pack.addEventListener("click", () => {
          loadEvidencePack(hit.rid).catch(() => {
            evidencePack.textContent = "Evidence pack unavailable here; open the Workbench through memory serve.";
          });
        });
        const packViewer = document.createElement("a");
        packViewer.className = "button-link";
        packViewer.textContent = "Pack Viewer";
        packViewer.href = "/docs/evidence-pack?rid=" + encodeURIComponent(String(hit.rid)) + "&max_bytes=8000";
        const related = document.createElement("button");
        related.type = "button";
        related.textContent = "Related";
        related.addEventListener("click", () => {
          loadRelated(hit.rid).catch(() => {
            relatedResults.replaceChildren();
            const item = document.createElement("li");
            item.textContent = "Related docs unavailable here; open the Workbench through memory serve.";
            relatedResults.append(item);
          });
        });
        const relatedViewer = document.createElement("a");
        relatedViewer.className = "button-link";
        relatedViewer.textContent = "Related Viewer";
        relatedViewer.href = "/docs/related?rid=" + encodeURIComponent(String(hit.rid));
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(hit.title || hit.path || "Untitled doc");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(hit.path || "") + " - score " + String(hit.score ?? "?");
        const excerpt = document.createElement("p");
        excerpt.textContent = String(hit.excerpt || "");
        content.append(title, meta, excerpt);
        const actions = document.createElement("div");
        actions.append(read, pack, packViewer, related, relatedViewer);
        item.append(actions, content);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Docs search unavailable here; open the Workbench through memory serve.";
    }
  });
  backlinksForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(backlinksInput.value || "").trim();
    backlinksResults.replaceChildren();
    if (!query) {
      backlinksStatus.textContent = "Enter a reference label, title, or rid.";
      return;
    }
    backlinksStatus.textContent = "Finding doc backlinks...";
    try {
      const key = /^[0-9]+$/.test(query) ? "rid" : "query";
      const response = await fetch("/api/docs/backlinks?" + key + "=" + encodeURIComponent(query), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const docs = Array.isArray(report.docs) ? report.docs.slice(0, 8) : [];
      const refs = Array.isArray(report.references) ? report.references.slice(0, 3) : [];
      backlinksStatus.textContent = String(refs.length) + " reference node(s), " + String(docs.length) + " doc backlink(s) shown.";
      for (const doc of docs) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(doc.title || doc.path || "Indexed doc");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(doc.path || "") + " - " + String(doc.matched_references ?? 0) + " matched reference(s)";
        item.append(title, meta);
        backlinksResults.append(item);
      }
      if (docs.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No indexed docs reference that node.";
        backlinksResults.append(item);
      }
    } catch (err) {
      backlinksStatus.textContent = "Doc backlinks unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function docsCoverageScript(): string {
  return `(() => {
  const button = document.getElementById("memory-docs-coverage-refresh");
  const status = document.getElementById("memory-docs-coverage-status");
  const results = document.getElementById("memory-docs-coverage-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing doc coverage...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/docs/coverage", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = String(report.grounded_docs ?? 0) + "/" + String(report.total_docs ?? 0) + " grounded, " + String(report.docs_with_references ?? 0) + " with references, vectors " + String(report.vector?.overall || "unknown") + ".";
      const docs = Array.isArray(report.docs) ? report.docs : [];
      const interesting = docs
        .filter((doc) => Number(doc.references?.count || 0) > 0 || doc.graph_status !== "grounded" || doc.vector_status !== "ready")
        .slice(0, 8);
      for (const doc of interesting) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(doc.title || doc.path || "Indexed doc");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(doc.path || "") + " - " + String(doc.graph_status || "unknown") + ", refs " + String(doc.references?.count ?? 0) + ", vector " + String(doc.vector_status || "unknown");
        item.append(title, meta);
        results.append(item);
      }
      if (interesting.length === 0) {
        const item = document.createElement("li");
        item.textContent = "All indexed docs are grounded with ready vectors; no reference-bearing docs to highlight.";
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Doc coverage unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function handoffScript(): string {
  return `(() => {
  const form = document.getElementById("memory-handoff-form");
  const input = document.getElementById("memory-handoff-focus");
  const viewerLink = document.getElementById("memory-handoff-link");
  const status = document.getElementById("memory-handoff-status");
  const results = document.getElementById("memory-handoff-results");
  const markdown = document.getElementById("memory-handoff-markdown");
  if (!form || !input || !viewerLink || !status || !results || !markdown) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const focus = String(input.value || "").trim();
    viewerLink.setAttribute("href", focus ? "/handoff?focus=" + encodeURIComponent(focus) : "/handoff");
    status.textContent = "Building handoff...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/handoff" + (focus ? "?focus=" + encodeURIComponent(focus) + "&limit=12" : "?limit=12"), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      status.textContent = String(summary.returned_items ?? 0) + " handoff item(s), status " + String(report.status || "unknown") + ".";
      const sections = Array.isArray(report.sections) ? report.sections : [];
      for (const section of sections) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(section.title || section.id || "Handoff section");
        const meta = document.createElement("p");
        meta.className = "meta";
        const items = Array.isArray(section.items) ? section.items : [];
        meta.textContent = String(items.length) + " item(s)";
        item.append(title, meta);
        results.append(item);
      }
      markdown.textContent = String(report.markdown || "");
    } catch (err) {
      status.textContent = "Handoff unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function contextPackScript(): string {
  return `(() => {
  const form = document.getElementById("memory-context-pack-form");
  const input = document.getElementById("memory-context-pack-goal");
  const viewerLink = document.getElementById("memory-context-pack-link");
  const status = document.getElementById("memory-context-pack-status");
  const results = document.getElementById("memory-context-pack-results");
  const markdown = document.getElementById("memory-context-pack-markdown");
  if (!form || !input || !viewerLink || !status || !results || !markdown) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const goal = String(input.value || "").trim();
    if (!goal) {
      status.textContent = "Context goal is required.";
      return;
    }
    viewerLink.setAttribute("href", "/context-pack?goal=" + encodeURIComponent(goal));
    status.textContent = "Building context pack...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/context-pack?goal=" + encodeURIComponent(goal) + "&budget_chars=2500&limit=8", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const pack = await response.json();
      const entries = Array.isArray(pack.entries) ? pack.entries : [];
      const coreContext = Array.isArray(pack.coreContext) ? pack.coreContext : [];
      const coreRids = new Set(coreContext.map((entry) => entry && entry.citation ? entry.citation.rid : null));
      const ordinary = entries.filter((entry) => !(entry && entry.citation && coreRids.has(entry.citation.rid)));
      const previewEntries = coreContext.map((entry) => ({ entry, core: true })).concat(ordinary.map((entry) => ({ entry, core: false })));
      status.textContent = String(entries.length) + " context item(s), " + String(coreContext.length) + " core, status " + String(pack.status || "unknown") + ".";
      for (const preview of previewEntries.slice(0, 8)) {
        const entry = preview.entry || {};
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(entry.title || "Context entry");
        const meta = document.createElement("p");
        meta.className = "meta";
        const citation = entry.citation || {};
        meta.textContent = (preview.core ? "core_context" : String(entry.section || "evidence")) + " - " + String(citation.urn || "");
        item.append(title, meta);
        results.append(item);
      }
      markdown.textContent = String(pack.markdown || "");
    } catch (err) {
      status.textContent = "Context pack unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function workFrontierScript(): string {
  return `(() => {
  const form = document.getElementById("memory-frontier-form");
  const input = document.getElementById("memory-frontier-focus");
  const viewerLink = document.getElementById("memory-frontier-link");
  const status = document.getElementById("memory-frontier-status");
  const results = document.getElementById("memory-frontier-results");
  const markdown = document.getElementById("memory-frontier-markdown");
  if (!form || !input || !viewerLink || !status || !results || !markdown) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const focus = String(input.value || "").trim();
    viewerLink.setAttribute("href", focus ? "/frontier?focus=" + encodeURIComponent(focus) : "/frontier");
    status.textContent = "Refreshing frontier...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/frontier" + (focus ? "?focus=" + encodeURIComponent(focus) + "&limit=12" : "?limit=12"), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      status.textContent = String(summary.ready ?? 0) + " ready, " + String(summary.blocked ?? 0) + " blocked, status " + String(report.status || "unknown") + ".";
      const ready = Array.isArray(report.ready) ? report.ready : [];
      const blocked = Array.isArray(report.blocked) ? report.blocked : [];
      for (const entry of ready.concat(blocked).slice(0, 8)) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(entry.title || "Work item");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(entry.citation || "") + " - priority " + String(entry.priority ?? "?");
        item.append(title, meta);
        results.append(item);
      }
      markdown.textContent = String(report.markdown || "");
    } catch (err) {
      status.textContent = "Work frontier unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function routingGuideScript(): string {
  return `(() => {
  const form = document.getElementById("memory-routing-guide-form");
  const input = document.getElementById("memory-routing-guide-agent");
  const viewerLink = document.getElementById("memory-routing-guide-link");
  const status = document.getElementById("memory-routing-guide-status");
  const results = document.getElementById("memory-routing-guide-results");
  if (!form || !input || !viewerLink || !status || !results) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const agent = String(input.value || "generic");
    viewerLink.setAttribute("href", "/routing-guide?agent=" + encodeURIComponent(agent));
    status.textContent = "Refreshing routing guide...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/routing-guide?agent=" + encodeURIComponent(agent), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const guide = await response.json();
      const integration = guide.integration || {};
      const targetFiles = Array.isArray(guide.targetFiles) ? guide.targetFiles : [];
      const tools = Array.isArray(guide.mcpTools) ? guide.mcpTools : [];
      const rules = Array.isArray(guide.rules) ? guide.rules : [];
      status.textContent = String(integration.displayName || agent) + ": " + String((integration.transports || []).join(", ")) + ".";
      addItem("Target files", targetFiles.join(", ") || "none");
      addItem("MCP tools", String(tools.length) + " tool(s)");
      addItem("Routing rules", String(rules.length) + " rule(s)");
    } catch (err) {
      status.textContent = "Routing guide unavailable here; open the Workbench through memory serve.";
    }
  });
  function addItem(titleText, metaText) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = metaText;
    item.append(title, meta);
    results.append(item);
  }
})();`.replaceAll("</", "<\\/");
}

export function agentIntegrationStatusScript(): string {
  return `(() => {
  const button = document.getElementById("memory-agent-integration-refresh");
  const status = document.getElementById("memory-agent-integration-status");
  const results = document.getElementById("memory-agent-integration-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing agent integration status...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/integration-status", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      status.textContent = String(summary.ready ?? 0) + "/" + String(summary.agents ?? 0) + " agent integration(s) ready.";
      const agents = Array.isArray(report.agents) ? report.agents.slice(0, 8) : [];
      for (const agent of agents) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(agent.display_name || agent.agent || "Agent");
        const meta = document.createElement("p");
        meta.className = "meta";
        const files = Array.isArray(agent.target_files) ? agent.target_files.map((file) => String(file.path || "")).join(", ") : "";
        meta.textContent = String(agent.state || "unknown") + " - " + files;
        item.append(title, meta);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Agent integration status unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function docsReferenceGraphScript(): string {
  return `(() => {
  const button = document.getElementById("memory-docs-reference-graph-refresh");
  const status = document.getElementById("memory-docs-reference-graph-status");
  const results = document.getElementById("memory-docs-reference-graph-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing doc reference graph...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/docs/reference-graph", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = String(report.reference_edges ?? 0) + " edge(s), " + String(report.reference_nodes ?? 0) + " referenced node(s), " + String(report.grounded_docs ?? 0) + "/" + String(report.total_docs ?? 0) + " grounded docs.";
      const refs = Array.isArray(report.top_references) ? report.top_references.slice(0, 8) : [];
      for (const ref of refs) {
        const item = document.createElement("li");
        item.className = "result";
        const count = document.createElement("span");
        count.className = "pill";
        count.textContent = String(ref.incoming_docs ?? 0);
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(ref.node?.title || ref.node?.label || "Referenced node");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(ref.node?.label || "") + " - referenced by doc count";
        content.append(title, meta);
        item.append(count, content);
        results.append(item);
      }
      if (refs.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No extracted document reference graph edges to show.";
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Doc reference graph unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function assetInventoryScript(): string {
  return `(() => {
  const button = document.getElementById("memory-assets-refresh");
  const status = document.getElementById("memory-assets-status");
  const results = document.getElementById("memory-assets-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing asset inventory...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/assets", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = String(report.total_assets ?? 0) + " asset(s), " + String(report.kinds?.length ?? 0) + " kind(s).";
      const assets = Array.isArray(report.assets) ? report.assets.slice(0, 8) : [];
      for (const asset of assets) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(asset.title || asset.path || "Asset");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(asset.asset_kind || "asset") + " - " + String(asset.media_type || "unknown") + " - " + String(asset.bytes ?? 0) + " byte(s)";
        item.append(title, meta);
        results.append(item);
      }
      if (assets.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No binary/document assets indexed yet.";
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Asset inventory unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function pathExplorerScript(): string {
  return `(() => {
  const form = document.getElementById("memory-path-form");
  const fromInput = document.getElementById("memory-path-from");
  const toInput = document.getElementById("memory-path-to");
  const status = document.getElementById("memory-path-status");
  const results = document.getElementById("memory-path-results");
  if (!form || !fromInput || !toInput || !status || !results) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const from = String(fromInput.value || "").trim();
    const to = String(toInput.value || "").trim();
    results.replaceChildren();
    if (!from || !to) {
      status.textContent = "Enter source and target labels.";
      return;
    }
    status.textContent = "Explaining path...";
    try {
      const response = await fetch("/api/path-explain?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) + "&max_depth=8", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = report.reachable ? "Reachable in " + String(report.hop_count) + " hop(s)." : "No directed path found.";
      const edges = Array.isArray(report.edges) ? report.edges : [];
      if (edges.length === 0 && Array.isArray(report.recommended_next_actions)) {
        for (const action of report.recommended_next_actions) {
          const item = document.createElement("li");
          item.textContent = String(action);
          results.append(item);
        }
        return;
      }
      for (const edge of edges) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(edge.from?.title || edge.from?.label || "?") + " --" + String(edge.label || "?") + "--> " + String(edge.to?.title || edge.to?.label || "?");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(edge.from?.label || "") + " -> " + String(edge.to?.label || "");
        item.append(title, meta);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Path explanation unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function communitiesScript(): string {
  return `(() => {
  const button = document.getElementById("memory-communities-refresh");
  const status = document.getElementById("memory-communities-status");
  const results = document.getElementById("memory-communities-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing communities...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/communities", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const communities = Array.isArray(report.communities) ? report.communities : [];
      status.textContent = String(communities.length) + " community(ies), " + String(report.assignments?.length ?? 0) + " assignment(s).";
      for (const community of communities.slice(0, 8)) {
        const item = document.createElement("li");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(community.id || "community");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = Array.isArray(community.titles) ? community.titles.join(", ") : "";
        const count = document.createElement("span");
        count.className = "pill";
        count.textContent = String(community.count ?? 0) + " node(s)";
        content.append(title, meta);
        item.append(content, count);
        results.append(item);
      }
    } catch (_) {
      status.textContent = "Communities unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function onboardingMapScript(): string {
  return `(() => {
  const button = document.getElementById("memory-onboarding-refresh");
  const status = document.getElementById("memory-onboarding-status");
  const results = document.getElementById("memory-onboarding-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing onboarding map...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/onboarding-map", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const map = await response.json();
      const summary = map.summary || {};
      status.textContent = String(map.status || "unknown") + ": " + String(summary.warnings ?? 0) + " warning(s).";
      const sections = map.sections || {};
      for (const key of ["concepts", "workflows", "decisions", "risks", "validations"]) {
        const entries = Array.isArray(sections[key]) ? sections[key] : [];
        if (entries.length === 0) continue;
        const item = document.createElement("li");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = key;
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = entries.slice(0, 3).map((entry) => String(entry.title || entry.urn || "")).filter(Boolean).join(", ");
        const count = document.createElement("span");
        count.className = "pill";
        count.textContent = String(entries.length);
        content.append(title, meta);
        item.append(content, count);
        results.append(item);
      }
    } catch (_) {
      status.textContent = "Onboarding map unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function vectorDiagnosticsScript(): string {
  return `(() => {
  const form = document.getElementById("memory-vector-form");
  const input = document.getElementById("memory-vector-query");
  const status = document.getElementById("memory-vector-status");
  const results = document.getElementById("memory-vector-results");
  if (!form || !input || !status || !results) return;
  async function refreshStatus() {
    try {
      const response = await fetch("/api/vector/status", { headers: { "accept": "application/json" } });
      if (!response.ok) return;
      const report = await response.json();
      status.textContent = "Vector projection " + String(report.overall || "unknown") + ": " + String(report.ready ?? 0) + "/" + String(report.total ?? 0) + " ready.";
    } catch (_) {
      status.textContent = "Vector status unavailable here; open the Workbench through memory serve.";
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(input.value || "").trim();
    results.replaceChildren();
    if (!query) {
      status.textContent = "Enter a vector query.";
      return;
    }
    status.textContent = "Searching vectors...";
    try {
      const response = await fetch("/api/vector/search?query=" + encodeURIComponent(query) + "&limit=5", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const hits = Array.isArray(report.hits) ? report.hits : [];
      status.textContent = report.status === "available" ? hits.length + " vector hit(s)." : "Vector search unavailable: " + String(report.error || "not ready");
      for (const hit of hits) {
        const item = document.createElement("li");
        item.className = "result";
        const score = document.createElement("span");
        score.className = "pill";
        score.textContent = String(hit.score ?? "?");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(hit.title || hit.label || "Untitled vector hit");
        const meta = document.createElement("p");
        meta.className = "meta";
        const assetMeta = hit.kind === "asset"
          ? " - " + String(hit.asset_kind || "asset") + " - " + String(hit.media_type || "unknown") + (hit.path ? " - " + String(hit.path) : "")
          : "";
        meta.textContent = String(hit.kind || hit.node_type || "node") + " - " + String(hit.label || "") + assetMeta;
        const excerpt = document.createElement("p");
        excerpt.textContent = String(hit.excerpt || "");
        content.append(title, meta, excerpt);
        item.append(score, content);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Vector diagnostics unavailable here; open the Workbench through memory serve.";
    }
  });
  refreshStatus();
})();`.replaceAll("</", "<\\/");
}

export function extractionStatusScript(): string {
  return `(() => {
  const button = document.getElementById("memory-extraction-refresh");
  const status = document.getElementById("memory-extraction-status");
  const results = document.getElementById("memory-extraction-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing extraction status...";
    try {
      const response = await fetch("/api/extraction/status", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      results.replaceChildren();
      const inferred = report.inferred || {};
      const first = document.createElement("li");
      const title = document.createElement("h3");
      title.textContent = inferred.available ? "Provider available" : "Local structured fallback";
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = String(inferred.facts ?? 0) + " inferred fact(s), Stop hook " + (inferred.hook_stop_enabled ? "enabled" : "disabled");
      first.append(title, meta);
      results.append(first);
      const deterministic = report.deterministic && typeof report.deterministic === "object"
        ? Object.entries(report.deterministic).filter(([, ready]) => ready).map(([key]) => String(key).replaceAll("_", " "))
        : [];
      const second = document.createElement("li");
      const detTitle = document.createElement("h3");
      detTitle.textContent = "Deterministic extractors";
      const detMeta = document.createElement("p");
      detMeta.className = "meta";
      detMeta.textContent = deterministic.join(", ");
      second.append(detTitle, detMeta);
      results.append(second);
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Extraction paths are ready.";
    } catch (err) {
      status.textContent = "Extraction status unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function governanceScript(): string {
  return `(() => {
  const button = document.getElementById("memory-governance-refresh");
  const status = document.getElementById("memory-governance-status");
  const results = document.getElementById("memory-governance-results");
  if (!button || !status || !results) return;
  function addItem(titleText, detailText) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing governance...";
    try {
      const response = await fetch("/api/governance", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      results.replaceChildren();
      addItem(String(report.status || "unknown"), String(summary.nodes_with_provenance ?? 0) + "/" + String(summary.total_nodes ?? 0) + " with provenance, " + String(summary.missing_provenance ?? 0) + " missing");
      addItem("Privacy and lint", String(summary.privacy_findings ?? 0) + " privacy finding(s), " + String(summary.lint_findings ?? 0) + " lint finding(s)");
      addItem("Contradictions", String(summary.unresolved_contradictions ?? 0) + " unresolved, " + String(summary.superseded_nodes ?? 0) + " superseded node(s)");
      const tidy = report.tidy_availability || {};
      addItem("Tidy availability", String(tidy.status || "unknown") + " - " + String(tidy.reason || tidy.next_action || "no tidy status reported"));
      const tidyRecommendations = report.tidy_recommendations || {};
      const tidySummary = tidyRecommendations.summary || {};
      addItem("Provider tidy recommendations", String(tidySummary.recommended_pairs ?? 0) + "/" + String(tidySummary.candidate_pairs ?? 0) + " duplicate or near-duplicate Soft-merge recommendation(s)");
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Governance report is clean.";
    } catch (err) {
      status.textContent = "Governance unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function decayScript(): string {
  return `(() => {
  const button = document.getElementById("memory-decay-refresh");
  const status = document.getElementById("memory-decay-status");
  const results = document.getElementById("memory-decay-results");
  if (!button || !status || !results) return;
  function addItem(titleText, detailText) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing decay plan...";
    try {
      const response = await fetch("/api/decay", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      const policy = report.policy || {};
      results.replaceChildren();
      addItem(String(report.status || "unknown"), String(summary.keep ?? 0) + " keep, " + String(summary.review ?? 0) + " review, " + String(summary.deprecate ?? 0) + " deprecate, " + String(summary.expire ?? 0) + " expire");
      addItem("Policy", String(policy.stale_days ?? 0) + "d stale, " + String(policy.deprecate_days ?? 0) + "d deprecate, pinned " + String(policy.pinned_importance_threshold ?? 0));
      const deprecate = Array.isArray(report.deprecate) ? report.deprecate[0] : null;
      if (deprecate) addItem("Deprecate candidate", String(deprecate.title || deprecate.citation || ""));
      const review = Array.isArray(report.review) ? report.review[0] : null;
      if (review) addItem("Review candidate", String(review.title || review.citation || ""));
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Decay plan is clean.";
    } catch (err) {
      status.textContent = "Decay plan unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function memoryHealthScript(): string {
  return `(() => {
  const button = document.getElementById("memory-health-refresh");
  const status = document.getElementById("memory-health-status");
  const results = document.getElementById("memory-health-results");
  if (!button || !status || !results) return;
  function addItem(titleText, detailText, className) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = className || "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing Memory health...";
    try {
      const response = await fetch("/api/memory/health", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      results.replaceChildren();
      addItem(String(report.state || "unknown"), String(report.stats?.nodes ?? 0) + " node(s), " + String(report.stats?.edges ?? 0) + " edge(s), " + String(report.stale?.stale ?? 0) + "/" + String(report.stale?.total ?? 0) + " stale", "meta");
      addItem(String(report.vector?.overall || "unknown"), String(report.vector?.ready ?? 0) + "/" + String(report.vector?.total ?? 0) + " vector item(s) ready, " + String(report.vector?.failed ?? 0) + " failed", "meta");
      addItem(String(report.skill_telemetry?.status || "unknown"), String(report.skill_telemetry?.rollups ?? 0) + " Skill telemetry rollup(s)", "meta");
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Memory health refreshed.";
    } catch (err) {
      status.textContent = "Memory health unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function learningDebtScript(): string {
  return `(() => {
  const button = document.getElementById("memory-learning-debt-refresh");
  const status = document.getElementById("memory-learning-debt-status");
  const results = document.getElementById("memory-learning-debt-results");
  if (!button || !status || !results) return;
  function totalDebt(summary) {
    return Number(summary?.repeatedFailurePatterns ?? 0)
      + Number(summary?.staleOrContradictedGuidance ?? 0)
      + Number(summary?.missingValidationEvidence ?? 0)
      + Number(summary?.skillTelemetryGaps ?? 0);
  }
  function addItem(titleText, detailText, className) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = className || "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing learning debt...";
    try {
      const response = await fetch("/api/learning-debt", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      const categories = report.categories || {};
      results.replaceChildren();
      addItem(String(report.status || "unknown"), String(totalDebt(summary)) + " debt signal(s), " + String(summary.skillTelemetryGaps ?? 0) + " telemetry gap(s)", "meta");
      const repeated = Array.isArray(categories.repeatedFailurePatterns) ? categories.repeatedFailurePatterns[0] : null;
      if (repeated) addItem("Repeated failure", String(repeated.pattern || "") + " - " + String(repeated.attemptCount || 0) + " attempt(s)", "meta");
      const validation = Array.isArray(categories.missingValidationEvidence) ? categories.missingValidationEvidence[0] : null;
      if (validation) addItem("Validation gap", String(validation.title || validation.evidence || ""), "meta");
      const telemetry = Array.isArray(categories.skillTelemetryGaps) ? categories.skillTelemetryGaps[0] : null;
      if (telemetry) addItem("Telemetry gap", String(telemetry.reason || telemetry.kind || ""), "meta");
      status.textContent = String(report.status || "Learning debt refreshed.");
    } catch (err) {
      status.textContent = "Learning debt unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function hookDiagnosticsScript(): string {
  return `(() => {
  const form = document.getElementById("memory-hooks-form");
  const input = document.getElementById("memory-hooks-session");
  const status = document.getElementById("memory-hooks-status");
  const results = document.getElementById("memory-hooks-results");
  if (!form || !input || !status || !results) return;
  function addItem(titleText, detailText, className) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = className || "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  async function loadHookCoverage() {
    const response = await fetch("/api/hooks/coverage", { headers: { "accept": "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const report = await response.json();
    const summary = report.summary || {};
    addItem(
      "Hook coverage",
      String(report.mode || "unknown") + ": " + String(summary.enabled_events ?? 0) + "/" + String(summary.total_events ?? 0) + " enabled, " + String(Array.isArray(report.gaps) ? report.gaps.length : 0) + " gap(s)",
      "meta",
    );
    const gaps = Array.isArray(report.gaps) ? report.gaps.slice(0, 4) : [];
    for (const gap of gaps) addItem("Gap", String(gap), "meta");
  }
  async function loadTimeline(sessionId) {
    const query = sessionId ? "?session=" + encodeURIComponent(sessionId) + "&limit=20" : "?limit=20";
    const response = await fetch("/api/session/timeline" + query, { headers: { "accept": "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const timeline = await response.json();
    const entries = Array.isArray(timeline.entries) ? timeline.entries.slice(-5).reverse() : [];
    addItem("Session timeline", String(timeline.summary?.events ?? 0) + " event(s), " + String(timeline.summary?.hook_events ?? 0) + " hook event(s)", "meta");
    for (const entry of entries) {
      addItem(String(entry.title || entry.kind || "Timeline event"), String(entry.occurred_at || "") + " - " + String(entry.detail || ""), "meta");
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    results.replaceChildren();
    status.textContent = "Refreshing hook diagnostics...";
    try {
      await loadHookCoverage();
      await loadTimeline(String(input.value || "").trim());
      status.textContent = "Hook diagnostics refreshed.";
    } catch (err) {
      status.textContent = "Hook diagnostics unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

export function layersScript(): string {
  return `(() => {
  const button = document.getElementById("memory-layers-refresh");
  const status = document.getElementById("memory-layers-status");
  const results = document.getElementById("memory-layers-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing layers...";
    try {
      const response = await fetch("/api/layers", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const layers = Array.isArray(report.layers) ? report.layers : [];
      results.replaceChildren();
      for (const layer of layers) {
        const item = document.createElement("li");
        item.className = "capability";
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(layer.title || layer.id || "Memory layer");
        const meta = document.createElement("p");
        meta.className = "meta";
        const counts = layer.counts && typeof layer.counts === "object" ? Object.entries(layer.counts).slice(0, 4) : [];
        meta.textContent = counts.map(([key, value]) => String(key) + "=" + String(value)).join(", ");
        const pill = document.createElement("span");
        pill.className = "pill " + (layer.status === "ready" ? "ok" : layer.status === "degraded" ? "bad" : "warn");
        pill.textContent = String(layer.status || "unknown");
        content.append(title, meta);
        item.append(content, pill);
        results.append(item);
      }
      status.textContent = String(report.summary?.ready_layers ?? 0) + "/" + String(report.summary?.total_layers ?? layers.length) + " layer(s) ready.";
    } catch (err) {
      status.textContent = "Layer report unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

