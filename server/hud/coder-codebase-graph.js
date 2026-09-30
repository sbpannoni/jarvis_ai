"use strict";
/* ===================== CODEBASE MAP (review launcher + pending view) =========
   A selectable dependency map of the codebase (GET /api/codebase-graph, built by
   codebase_graph.py / grimp on snarf; darkhelix package + the scripts tree).

   LAUNCHER: click a module -> its blast radius (itself + 1-hop neighbourhood)
   highlights -> RUN a review (POST /api/review-file, sweep|deep).
   PENDING VIEW: nodes are coloured by their latest review outcome
   (GET /api/review-status): red border = findings, green = clean, dim = never
   reviewed. "pending only" hides the clean ones. Open DARKHELIX GitHub issues
   (GET /api/darkhelix-todo, the tracker) are overlaid too: a node whose file an
   open issue names gets an amber outline + a "flag N" count; selecting it lists
   the issues (with links) in the toolbar. Issue->file mapping is deliberately
   conservative -- a token match on the file's path, its basename.py, or (for
   package nodes) its dotted module -- so it only lights up issues that actually
   name a file, and never fires on prose that happens to contain a bare word
   like "context" or "utils". "issues only" hides nodes with none.

   Layout is concentric on fan-in by default, so the highest-blast-radius modules
   sit at the centre and are drawn largest -- the geometry IS the blast radius.
   The "group by cluster" toggle switches to compound super-nodes (one box per
   package/dir, from each node's `cluster`) laid out with core cytoscape's `cose`
   -- an opt-in view that leaves the concentric default untouched. Core cytoscape
   only (vendored), no layout extension; a nicer ELK/fcose "metro" layout and
   collapsible clusters are the remaining aesthetic pass (needs visual iteration).
   Depends on: cytoscape (vendor/cytoscape.min.js), openWorkTabTurning (app.js). */

function _cbgInjectStyle(){
  if (document.getElementById("cbg-style")) return;
  const s = document.createElement("style");
  s.id = "cbg-style";
  s.textContent = `
    .cbg-wrap{display:flex;flex-direction:column;height:78vh;gap:8px}
    .cbg-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      padding:6px 10px;border:1px solid var(--line,#234);border-radius:8px;
      background:rgba(0,0,0,.25);font-size:12px}
    .cbg-target{color:var(--cyan,#5cf);font-weight:600;min-width:180px}
    .cbg-hint{color:var(--txt-dim,#89a);font-size:11px}
    .cbg-canvas{flex:1;border:1px solid var(--line,#234);border-radius:8px;
      background:radial-gradient(circle at 50% 45%,rgba(40,60,90,.18),rgba(0,0,0,.30))}
    .cbg-status.saved{color:var(--green,#6e6)} .cbg-status.err{color:var(--red,#f77)}
    .cbg-issues{font-size:11px;color:#f5a623} .cbg-issues a{color:#f5a623;text-decoration:none;margin-right:2px}
    .cbg-issues a:hover{text-decoration:underline}
    .cbg-dot{display:inline-block;width:9px;height:9px;border-radius:50%;
      vertical-align:middle;margin:0 3px 0 8px}
  `;
  document.head.appendChild(s);
}

// Swimlanes: after dagre has ranked modules by dependency depth (the y axis, the
// top-to-bottom flow), reassign x so every cluster occupies its OWN disjoint
// vertical lane. dagre keeps a lineage together but its cluster bounding boxes
// still overlap because clusters span many depths; pinning each cluster to a lane
// makes the compound parents render as clean, non-overlapping category bands while
// the depth flow is preserved. Cross-lane edges are the inter-category deps.
function _cbgSwimlanes(cy){
  const reals = cy.nodes().filter(n => !n.data("isParent"));
  if (reals.length === 0) return;
  const avgY = arr => arr.reduce((s, n) => s + n.position("y"), 0) / arr.length;
  const byCluster = {};
  reals.forEach(n => { (byCluster[n.data("cluster")] = byCluster[n.data("cluster")] || []).push(n); });
  // Order lanes left-to-right by average dependency depth (upstream/entry clusters
  // first), tie-broken by size, so the eye still reads a pipeline progression.
  const clusters = Object.keys(byCluster).sort((a, b) =>
    (avgY(byCluster[a]) - avgY(byCluster[b])) || (byCluster[b].length - byCluster[a].length));
  const NODE_DX = 48, ROW_H = 64, LANE_GAP = 84;
  let x = 0;
  for (const c of clusters){
    const members = byCluster[c];
    // Re-rank locally within the lane (from dagre's depth order) so every lane
    // starts at the top -- compact side-by-side columns instead of a diagonal
    // staircase, while intra-cluster dependency order is preserved.
    const ys = [...new Set(members.map(n => Math.round(n.position("y"))))].sort((p, q) => p - q);
    const buckets = {};   // local rank -> nodes
    members.forEach(n => { const r = ys.indexOf(Math.round(n.position("y"))); (buckets[r] = buckets[r] || []).push(n); });
    const maxPer = Math.max(...Object.values(buckets).map(b => b.length));
    const laneW = Math.max(1, maxPer) * NODE_DX;
    for (const r of Object.keys(buckets)){
      const arr = buckets[r].sort((a, b) => (b.data("fan_in") || 0) - (a.data("fan_in") || 0));
      arr.forEach((n, i) => {
        const off = (i - (arr.length - 1) / 2) * NODE_DX;
        n.position({ x: x + laneW / 2 + off, y: Number(r) * ROW_H });
      });
    }
    x += laneW + LANE_GAP;
  }
}

// Broad category from a fine cluster id: the first two path/dotted segments
// (darkhelix.collab -> darkhelix/collab, src/components/viz3d -> src/components).
// This is the banding/coloring unit -- coarser than the raw cluster so the flow
// reads as a handful of broad pipeline areas, not dozens of leaf directories.
function _cbgCategory(cluster){
  const parts = String(cluster).split(/[./]/).filter(Boolean);
  return parts.slice(0, 2).join("/") || String(cluster);
}

function _cbgClusterColor(cluster){
  let h = 0;
  for (let i = 0; i < cluster.length; i++) h = (h * 31 + cluster.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360},70%,58%)`;
}

function _cbgEsc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

// The strings that count as an issue "naming" this node's file: full repo path,
// bare basename.py, and -- for package nodes (id has a dot, not a .py path) --
// the dotted module. No bare stem, so "utils"/"context" in prose never match.
function _cbgIssueTokens(n){
  const toks = new Set([n.file, (n.file || "").split("/").pop()]);
  if (n.id.includes(".") && !n.id.endsWith(".py")) toks.add(n.id);
  return [...toks].filter(Boolean);
}

function _cbgReviewState(rec){
  if (!rec) return "unreviewed";
  if (rec.status === "running") return "reviewing";
  if ((rec.findings || 0) > 0) return "findings";
  if (rec.no_issues_found) return rec.high_confidence_clean ? "clean-hi" : "clean";
  return "reviewed";
}

// Mark the node for `file` as under review in the LIVE graph (no re-render), so
// the click gives instant feedback before the server/dispatcher confirm it.
function _cbgMarkNodeReviewing(panel, file){
  const cy = panel._cbgCy; if (!cy) return;
  cy.nodes().filter(n => n.data("file") === file).data("review", "reviewing");
}

// Poll /api/review-status until this file leaves the "running" state (or we give
// up), then refresh the map with the recorded outcome. Bound to the render that
// started it (panel._cbgRenderId) so it stops if the panel is re-rendered/closed.
async function _cbgPollReview(panel, file){
  const myRender = panel._cbgRenderId;
  const started = Date.now();
  const MAX_MS = 75 * 60 * 1000;   // reviews run ~47 min; stop watching after 75
  while (panel._cbgRenderId === myRender && panel.isConnected){
    await new Promise(res => setTimeout(res, 12000));
    if (panel._cbgRenderId !== myRender || !panel.isConnected) return;
    let status = {};
    try{
      const sr = await fetch("/api/review-status");
      status = sr.ok ? ((await sr.json()).status || {}) : {};
    }catch(e){ continue; }   // transient; keep watching
    const rec = status[file];
    if (rec && rec.status !== "running"){
      const statusEl = panel.querySelector(".cbg-status");
      if (statusEl){
        const st = _cbgReviewState(rec);
        statusEl.textContent = st === "findings"
          ? `${rec.findings} finding${rec.findings === 1 ? "" : "s"} on ${file} — see kanban`
          : (st === "clean" || st === "clean-hi"
              ? `clean${st === "clean-hi" ? " (high confidence)" : ""}: ${file}`
              : `review done: ${file}`);
        statusEl.className = "cbg-status saved";
      }
      renderCodebaseMap(panel);   // full refresh picks up the outcome + overlay
      return;
    }
    if (Date.now() - started > MAX_MS){
      const statusEl = panel.querySelector(".cbg-status");
      if (statusEl){
        statusEl.textContent = `still running? gave up watching ${file} — check the kanban board`;
        statusEl.className = "cbg-status err";
      }
      return;
    }
  }
}

async function _cbgRunReview(panel){
  const target = panel._cbgSelected;
  const statusEl = panel.querySelector(".cbg-status");
  const modeSel = panel.querySelector(".cbg-mode");
  if (!target){ statusEl.textContent = "select a module first"; statusEl.className = "cbg-status err"; return; }
  statusEl.textContent = `dispatching review of ${target} …`;
  statusEl.className = "cbg-status";
  try{
    // async:true -> the review runs in the server background and we poll; the
    // call returns at once instead of blocking the whole ~47-min run.
    const r = await fetch("/api/review-file", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({target_file: target, mode: modeSel ? modeSel.value : "sweep", async: true}),
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    statusEl.textContent = j.already_running
      ? `already reviewing ${target} … (runs in background)`
      : `reviewing ${target} … (runs in background; can take many minutes)`;
    statusEl.className = "cbg-status";
    _cbgMarkNodeReviewing(panel, target);
    _cbgPollReview(panel, target);
  }catch(err){
    statusEl.textContent = `error: ${err.message}`;
    statusEl.className = "cbg-status err";
  }
}

function _cbgSelect(panel, cy, node){
  if (node.data("isParent")){   // a cluster box: highlight its members, nothing to review
    panel._cbgSelected = null;
    panel.querySelector(".cbg-target").textContent =
      `${node.data("label")}  (cluster — ${node.children().length} modules)`;
    cy.elements().addClass("cbg-faded").removeClass("cbg-hl");
    node.descendants().add(node).removeClass("cbg-faded").addClass("cbg-hl");
    const issEl0 = panel.querySelector(".cbg-issues"); if (issEl0) issEl0.innerHTML = "";
    return;
  }
  panel._cbgSelected = node.data("file") || null;
  const tEl = panel.querySelector(".cbg-target");
  tEl.textContent = node.data("file")
    ? `${node.data("id")}  (fan-in ${node.data("fan_in")}, fan-out ${node.data("fan_out")})`
    : `${node.data("id")}  (no source file)`;
  const nb = node.closedNeighborhood();
  cy.elements().addClass("cbg-faded").removeClass("cbg-hl");
  nb.removeClass("cbg-faded").addClass("cbg-hl");
  const issEl = panel.querySelector(".cbg-issues");
  if (issEl){
    const list = (panel._cbgIssuesByNode || {})[node.id()] || [];
    issEl.innerHTML = list.length
      ? "⚑ " + list.map(it =>
          `<a href="${_cbgEsc(it.url)}" target="_blank" rel="noopener" title="${_cbgEsc(it.title)}"`
          + `>#${_cbgEsc(it.issue)}</a>`).join(" ")
      : "";
  }
}

async function renderCodebaseMap(panel){
  _cbgInjectStyle();
  // Bump the render id: invalidates in-flight polls AND lets a superseded render
  // (e.g. the scope was switched before the first fetch returned) bail after its
  // awaits instead of racing to build a second graph on the live canvas.
  const myRenderId = panel._cbgRenderId = (panel._cbgRenderId || 0) + 1;
  if (typeof cytoscape === "undefined"){
    panel.innerHTML = `<div class="kv"><span class="err">cytoscape not loaded (vendor/cytoscape.min.js)</span></div>`;
    return;
  }
  const prevMode = panel.querySelector(".cbg-mode")?.value || "sweep";
  panel.innerHTML = `
    <div class="cbg-wrap">
      <div class="cbg-toolbar">
        <select class="cbg-scope" title="which subsystem to map: the Python pipeline or the Electron/TS app">
          <option value="pipeline">pipeline · py</option><option value="app">app · ts</option>
        </select>
        <span class="cbg-target">click a module…</span>
        <select class="cbg-mode" title="sweep = breadth only (fast); deep = deep pass when the sweep is clean">
          <option value="sweep">sweep</option><option value="deep">deep (on clean)</option>
        </select>
        <button type="button" class="btn cbg-run">RUN REVIEW</button>
        <label title="hide modules that reviewed clean"><input type="checkbox" class="cbg-pending"> pending only</label>
        <label title="hide standalone modules with no internal dependencies"><input type="checkbox" class="cbg-iso"> hide unconnected</label>
        <label title="show only modules that an open GitHub issue names"><input type="checkbox" class="cbg-issuesonly"> issues only</label>
        <label title="group modules into compound boxes by package/dir (cose layout)"><input type="checkbox" class="cbg-group"> group by cluster</label>
        <span class="cbg-status"></span>
        <span class="cbg-issues"></span>
        <span class="cbg-hint"><span class="cbg-dot" style="background:#f66"></span>findings<span class="cbg-dot" style="background:#6e6"></span>clean<span class="cbg-dot" style="background:#556"></span>unreviewed<span class="cbg-dot" style="box-shadow:0 0 0 2px #5cf inset;background:transparent"></span>reviewing<span class="cbg-dot" style="box-shadow:0 0 0 2px #f5a623 inset;background:transparent"></span>open issue · dashed = changed since review · size = blast radius</span>
      </div>
      <div class="cbg-canvas"></div>
    </div>`;
  const modeSel = panel.querySelector(".cbg-mode");
  if (modeSel) modeSel.value = prevMode;
  let storedScope = null;
  try { storedScope = localStorage.getItem("cbg-scope"); } catch (e) { /* private mode */ }
  const scope = panel._cbgScope || storedScope || "pipeline";   // persists across re-renders and reopens
  const scopeSel = panel.querySelector(".cbg-scope");
  if (scopeSel){
    scopeSel.value = scope;
    scopeSel.addEventListener("change", () => {
      panel._cbgScope = scopeSel.value;
      try { localStorage.setItem("cbg-scope", scopeSel.value); } catch (e) { /* private mode */ }
      renderCodebaseMap(panel);
    });
  }
  const group = !!panel._cbgGroup;   // grouped view persists across re-renders
  const groupBox0 = panel.querySelector(".cbg-group");
  if (groupBox0) groupBox0.checked = group;
  const canvas = panel.querySelector(".cbg-canvas");
  panel.querySelector(".cbg-run").addEventListener("click", () => _cbgRunReview(panel));

  let data, status = {}, issues = [];
  try{
    const [gr, sr, ir] = await Promise.all([
      fetch(scope === "app" ? "/api/codebase-graph-ts" : "/api/codebase-graph"),
      fetch("/api/review-status"),
      fetch("/api/darkhelix-todo").catch(() => null),   // overlay only -- never fatal
    ]);
    data = await gr.json();
    if (data.error) throw new Error(data.error);
    status = sr.ok ? ((await sr.json()).status || {}) : {};
    try{ if (ir && ir.ok) issues = (await ir.json()).items || []; }catch(e){ issues = []; }
  }catch(err){
    if (panel._cbgRenderId !== myRenderId) return;   // superseded; don't clobber the newer render
    canvas.innerHTML = `<div class="kv"><span class="err">codebase graph unavailable: ${err.message}</span></div>`;
    return;
  }
  if (panel._cbgRenderId !== myRenderId) return;   // a newer render started while we awaited; stop

  // Pre-flatten each issue to a searchable haystack once (title + body).
  const issueHay = issues.map(it => ({
    issue: it.issue, url: it.url, title: it.title, blocked: it.blocked, wip: it.wip,
    hay: `${it.title || ""} \n${it.text || ""}`,
  }));
  panel._cbgIssuesByNode = {};

  const maxFanIn = Math.max(1, ...data.nodes.map(n => n.fan_in));
  const elements = [];
  const clusters = new Set();
  // Broad category per node, merging tiny categories (<3 members) up into their
  // top-level segment so the banding stays to a handful of meaningful areas.
  const rawCat = {};
  for (const n of data.nodes) rawCat[n.id] = _cbgCategory(n.cluster);
  const catCount = {};
  for (const id in rawCat) catCount[rawCat[id]] = (catCount[rawCat[id]] || 0) + 1;
  const catOf = id => (catCount[rawCat[id]] >= 3 ? rawCat[id] : (rawCat[id].split("/")[0] || rawCat[id]));
  const clusterColorById = {};   // node id -> its category color, for tinting edges into "lines"
  for (const n of data.nodes) clusterColorById[n.id] = _cbgClusterColor(catOf(n.id));
  for (const n of data.nodes){
    const rec = n.file ? status[n.file] : null;
    const stale = !!(rec && rec.file_sha && n.last_commit && rec.file_sha !== n.last_commit);
    const toks = _cbgIssueTokens(n);
    const nIssues = toks.length ? issueHay.filter(it => toks.some(t => it.hay.includes(t))) : [];
    if (nIssues.length) panel._cbgIssuesByNode[n.id] = nIssues;
    // Strip the source extension BEFORE taking the last path/dotted segment -- for
    // a loose/TS file id like "run_pipeline.py" or "src/views/report/types.ts",
    // splitting first would pop "py"/"ts" as the name.
    const base = n.id.replace(/\.(py|tsx?|jsx?)$/, "").split(/[./]/).filter(Boolean).pop();
    const cat = catOf(n.id);
    clusters.add(cat);
    elements.push({ data: {
      id: n.id, label: nIssues.length ? `${base}\n⚑${nIssues.length}` : base,
      file: n.file, fan_in: n.fan_in, fan_out: n.fan_out, cluster: cat,
      color: _cbgClusterColor(cat), review: _cbgReviewState(rec),
      findings_n: rec ? (rec.findings || 0) : 0, stale: stale,
      issues_n: nIssues.length,
      // Compound in BOTH views: the flow view lays categories out with dagre so
      // lineages stay together under a labeled category band; the grouped view
      // packs them tight with fcose. Membership is the same either way.
      parent: `cluster:${cat}`,
    }});
  }
  // Compound super-node per cluster. fan_in:0 keeps the fan-in size mapData off
  // NaN; cytoscape auto-fits a parent to its children. Rendered as a tinted,
  // labeled band behind the flow (or a box in the grouped view).
  for (const c of clusters){
    elements.push({ data: {
      id: `cluster:${c}`, label: c, isParent: true, fan_in: 0,
      color: _cbgClusterColor(c),
    }});
  }
  for (const e of data.edges){
    elements.push({ data: {
      id: `${e.source}__${e.target}`, source: e.source, target: e.target,
      // Tint each edge by the cluster it leaves, so the flow view reads as a set
      // of colored subway lines rather than one grey web.
      lineColor: clusterColorById[e.source] || "rgba(140,190,235,.55)",
    } });
  }

  const cy = cytoscape({
    container: canvas,
    elements,
    wheelSensitivity: 0.2,
    style: [
      { selector: "node", style: {
        "background-color": "data(color)",
        "label": "data(label)", "font-size": 9, "color": "#dfe8f5",
        "text-valign": "center", "text-halign": "center",
        "text-wrap": "wrap",
        // Labels are hidden by default; only "major stations" (busiest hubs) and
        // the hovered node reveal their name, so the overview stays legible.
        "text-opacity": 0,
        "text-outline-width": 2, "text-outline-color": "#0a0f1a",
        "width": `mapData(fan_in, 0, ${maxFanIn}, 20, 74)`,
        "height": `mapData(fan_in, 0, ${maxFanIn}, 20, 74)`,
        "border-width": 2, "border-color": "rgba(255,255,255,.25)",
      }},
      { selector: 'node[review="findings"]', style: { "border-color": "#f66", "border-width": 4 } },
      { selector: 'node[review="clean"]', style: { "border-color": "#6e6", "border-width": 3 } },
      { selector: 'node[review="clean-hi"]', style: { "border-color": "#7f7", "border-width": 4 } },
      { selector: 'node[review="unreviewed"]', style: { "border-color": "rgba(120,130,160,.5)" } },
      { selector: 'node[review="reviewing"]', style: { "border-color": "#5cf", "border-width": 5 } },
      { selector: "node[?stale]", style: { "border-style": "dashed" } },
      // Open-issue overlay: amber outline sits OUTSIDE the review border, so a
      // node can show its review state and "has open issues" at once.
      { selector: "node[issues_n > 0]", style: {
        "outline-color": "#f5a623", "outline-width": 3, "outline-offset": 2 } },
      // Flow (subway) view uses right-angled "round-taxi" routing so edges read
      // as transit lines along the left-to-right dependency spine; the grouped
      // view keeps soft bezier curves inside its cluster boxes.
      { selector: "edge", style: group ? {
        "width": 1, "line-color": "rgba(150,180,220,.35)",
        "target-arrow-color": "rgba(150,180,220,.5)", "target-arrow-shape": "triangle",
        "arrow-scale": 0.7, "curve-style": "bezier",
      } : {
        "width": 2, "line-color": "data(lineColor)", "line-opacity": 0.5,
        "target-arrow-color": "data(lineColor)", "target-arrow-shape": "triangle",
        "arrow-scale": 0.55, "curve-style": "round-taxi",
        "taxi-direction": "vertical", "taxi-turn": "40%", "taxi-turn-min-distance": 6,
        "taxi-radius": 10,
      }},
      { selector: ".cbg-faded", style: { "opacity": 0.12 } },
      // Named stations: the busiest hubs (cbg-major) always show their label; any
      // node reveals its name on hover (cbg-hover). Label sits below the station
      // on a chip so it reads like a metro stop.
      { selector: "node.cbg-major, node.cbg-hover", style: {
        "text-opacity": 1, "font-size": 12, "text-valign": "bottom", "text-margin-y": 4,
        "text-background-color": "#0a0f1a", "text-background-opacity": 0.72,
        "text-background-padding": 3, "text-background-shape": "roundrectangle",
        "text-outline-width": 0, "color": "#eaf2ff", "z-index": 30,
      }},
      // cytoscape's stylesheet parser can't resolve CSS var(); use literal hex
      // like the rest of this sheet, or the highlight silently keeps its base color.
      { selector: "node.cbg-hl", style: { "border-color": "#5cf" } },
      { selector: "edge.cbg-hl", style: {
        "line-color": "#5cf", "target-arrow-color": "#5cf",
        "width": 2, "opacity": 1 } },
      // Category bands (behind the flow) / cluster boxes (grouped view) -- last so
      // it wins the base-node props for parents; the attribute-gated review/issue
      // selectors never match them. Tinted fill + a bold header in the category
      // color so each broad area reads at a glance.
      { selector: "node[?isParent]", style: {
        "background-color": "data(color)", "background-opacity": 0.10,
        "shape": "round-rectangle", "border-width": 1, "border-color": "data(color)",
        "border-opacity": 0.55,
        "label": "data(label)", "text-valign": "top", "text-halign": "center",
        "font-size": 15, "font-weight": "bold", "color": "data(color)",
        "text-outline-width": 2, "text-outline-color": "#060a12",
        "text-transform": "uppercase", "min-zoomed-font-size": 5,
        "padding": "16px", "text-margin-y": -4, "events": "no",
      }},
    ],
    // Layout is run manually below (per view) so the flow view can lay out only
    // the connected graph and then corral standalone scripts into a side rail.
    layout: { name: "preset" },
  });

  panel._cbgCy = cy;   // so _cbgRunReview / poll can touch the live graph

  if (group) {
    // fcose (registered in vendor-bootstrap.js) is compound-aware and keeps
    // cluster boxes compact. Built-in cose blew this same graph up to a
    // ~100k-px canvas (fit zoom ~0.01 -> sub-pixel nodes, blank canvas).
    cy.layout({ name: "fcose", animate: false, fit: true, padding: 30,
      quality: "default", nodeDimensionsIncludeLabels: true,
      idealEdgeLength: 60, nodeRepulsion: 4500, gravity: 0.25,
      gravityCompound: 1.0, nestingFactor: 0.1 }).run();
  } else {
    // Flow view. Name the busiest hubs as "major stations" (always-on labels):
    // top hubs by fan-in (most depended-on) plus top roots by fan-out (entry
    // points like run_pipeline.py, whose significance is what they pull in).
    const real = cy.nodes().filter(n => !n.data("isParent")).toArray();
    const byIn = [...real].sort((a, b) => (b.data("fan_in") || 0) - (a.data("fan_in") || 0)).slice(0, 8);
    const byOut = [...real].sort((a, b) => (b.data("fan_out") || 0) - (a.data("fan_out") || 0)).slice(0, 2);
    cy.collection([...byIn, ...byOut]).addClass("cbg-major");
    // Rank by dependency depth with dagre on the modules only (parents excluded,
    // so ranking isn't perturbed by cluster boxes), then pin each cluster to its
    // own vertical lane so the compound parents become clean category bands. dagre
    // breaks import cycles automatically.
    const noParents = cy.elements().filter(e => !e.data("isParent"));
    const lay = noParents.layout({ name: "dagre", rankDir: "TB", animate: false, fit: false,
      nodeSep: 18, edgeSep: 8, rankSep: 70, ranker: "network-simplex" });
    lay.one("layoutstop", () => { _cbgSwimlanes(cy); cy.fit(undefined, 30); });
    lay.run();
  }

  // Reveal any node's name on hover (major stations show theirs already).
  cy.on("mouseover", "node", evt => { if (!evt.target.data("isParent")) evt.target.addClass("cbg-hover"); });
  cy.on("mouseout", "node", evt => evt.target.removeClass("cbg-hover"));
  cy.on("tap", "node", evt => _cbgSelect(panel, cy, evt.target));
  cy.on("tap", evt => { if (evt.target === cy){
    cy.elements().removeClass("cbg-faded cbg-hl");
    const issEl = panel.querySelector(".cbg-issues"); if (issEl) issEl.innerHTML = "";
  } });

  const pendingBox = panel.querySelector(".cbg-pending");
  pendingBox.addEventListener("change", () => {
    const clean = cy.nodes('[review="clean"], [review="clean-hi"], [review="reviewed"]');
    clean.style("display", pendingBox.checked ? "none" : "element");
  });

  const isoBox = panel.querySelector(".cbg-iso");
  isoBox.addEventListener("change", () => {
    const iso = cy.nodes().filter(n => !n.data("isParent") && n.degree(false) === 0);
    iso.style("display", isoBox.checked ? "none" : "element");
  });

  const issuesOnlyBox = panel.querySelector(".cbg-issuesonly");
  issuesOnlyBox.addEventListener("change", () => {
    const none = cy.nodes().filter(n => !n.data("isParent") && (n.data("issues_n") || 0) === 0);
    none.style("display", issuesOnlyBox.checked ? "none" : "element");
  });

  const groupBox = panel.querySelector(".cbg-group");
  groupBox.addEventListener("change", () => {
    panel._cbgGroup = groupBox.checked;   // grouping changes the element set + layout
    renderCodebaseMap(panel);             // so rebuild rather than restyle
  });
}

function openCodebaseMap(){
  openWorkTabTurning("codebase-map", "main", "CODEBASE MAP", (panel) => {
    panel.classList.add("flow-pane");
    panel.innerHTML = `<div class="kv"><span>loading…</span></div>`;
    renderCodebaseMap(panel);
  });
}

document.querySelectorAll('[data-action="codebase-map"]').forEach(b => b.addEventListener("click", openCodebaseMap));
