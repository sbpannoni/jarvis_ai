"use strict";
/* ===================== CODEBASE MAP (review launcher + pending view) =========
   A selectable dependency map of the codebase (GET /api/codebase-graph, built by
   codebase_graph.py / grimp on snarf; darkhelix package + the scripts tree).

   LAUNCHER: click a module -> its blast radius (itself + 1-hop neighbourhood)
   highlights -> RUN a review (POST /api/review-file, sweep|deep).
   PENDING VIEW: nodes are coloured by their latest review outcome
   (GET /api/review-status): red border = findings, green = clean, dim = never
   reviewed. "pending only" hides the clean ones.

   Layout is concentric on fan-in, so the highest-blast-radius modules sit at the
   centre and are drawn largest -- the geometry IS the blast radius. Core
   cytoscape (vendored), no layout extension. Clustering/ELK is a later pass.
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
    .cbg-dot{display:inline-block;width:9px;height:9px;border-radius:50%;
      vertical-align:middle;margin:0 3px 0 8px}
  `;
  document.head.appendChild(s);
}

function _cbgClusterColor(cluster){
  let h = 0;
  for (let i = 0; i < cluster.length; i++) h = (h * 31 + cluster.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360},70%,58%)`;
}

function _cbgReviewState(rec){
  if (!rec) return "unreviewed";
  if ((rec.findings || 0) > 0) return "findings";
  if (rec.no_issues_found) return rec.high_confidence_clean ? "clean-hi" : "clean";
  return "reviewed";
}

async function _cbgRunReview(panel){
  const target = panel._cbgSelected;
  const statusEl = panel.querySelector(".cbg-status");
  const modeSel = panel.querySelector(".cbg-mode");
  if (!target){ statusEl.textContent = "select a module first"; statusEl.className = "cbg-status err"; return; }
  statusEl.textContent = `reviewing ${target} … (may take several minutes)`;
  statusEl.className = "cbg-status";
  try{
    const r = await fetch("/api/review-file", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({target_file: target, mode: modeSel ? modeSel.value : "sweep"}),
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    if (j.no_issues_found){
      statusEl.textContent = `clean${j.high_confidence_clean ? " (high confidence)" : ""}: ${target}`;
    } else {
      const n = (j.findings || []).length;
      statusEl.textContent = `${n} finding${n === 1 ? "" : "s"} on ${target}${j.task ? ` -> card ${j.task.id}` : ""}`;
    }
    statusEl.className = "cbg-status saved";
    renderCodebaseMap(panel);   // refresh the overlay with the new outcome
  }catch(err){
    statusEl.textContent = `error: ${err.message}`;
    statusEl.className = "cbg-status err";
  }
}

function _cbgSelect(panel, cy, node){
  panel._cbgSelected = node.data("file") || null;
  const tEl = panel.querySelector(".cbg-target");
  tEl.textContent = node.data("file")
    ? `${node.data("id")}  (fan-in ${node.data("fan_in")}, fan-out ${node.data("fan_out")})`
    : `${node.data("id")}  (no source file)`;
  const nb = node.closedNeighborhood();
  cy.elements().addClass("cbg-faded").removeClass("cbg-hl");
  nb.removeClass("cbg-faded").addClass("cbg-hl");
}

async function renderCodebaseMap(panel){
  _cbgInjectStyle();
  if (typeof cytoscape === "undefined"){
    panel.innerHTML = `<div class="kv"><span class="err">cytoscape not loaded (vendor/cytoscape.min.js)</span></div>`;
    return;
  }
  const prevMode = panel.querySelector(".cbg-mode")?.value || "sweep";
  panel.innerHTML = `
    <div class="cbg-wrap">
      <div class="cbg-toolbar">
        <span class="cbg-target">click a module…</span>
        <select class="cbg-mode" title="sweep = breadth only (fast); deep = deep pass when the sweep is clean">
          <option value="sweep">sweep</option><option value="deep">deep (on clean)</option>
        </select>
        <button type="button" class="btn cbg-run">RUN REVIEW</button>
        <label title="hide modules that reviewed clean"><input type="checkbox" class="cbg-pending"> pending only</label>
        <label title="hide standalone modules with no internal dependencies"><input type="checkbox" class="cbg-iso"> hide unconnected</label>
        <span class="cbg-status"></span>
        <span class="cbg-hint"><span class="cbg-dot" style="background:#f66"></span>findings<span class="cbg-dot" style="background:#6e6"></span>clean<span class="cbg-dot" style="background:#556"></span>unreviewed · dashed = changed since review · size = blast radius</span>
      </div>
      <div class="cbg-canvas"></div>
    </div>`;
  const modeSel = panel.querySelector(".cbg-mode");
  if (modeSel) modeSel.value = prevMode;
  const canvas = panel.querySelector(".cbg-canvas");
  panel.querySelector(".cbg-run").addEventListener("click", () => _cbgRunReview(panel));

  let data, status = {};
  try{
    const [gr, sr] = await Promise.all([fetch("/api/codebase-graph"), fetch("/api/review-status")]);
    data = await gr.json();
    if (data.error) throw new Error(data.error);
    status = sr.ok ? ((await sr.json()).status || {}) : {};
  }catch(err){
    canvas.innerHTML = `<div class="kv"><span class="err">codebase graph unavailable: ${err.message}</span></div>`;
    return;
  }

  const maxFanIn = Math.max(1, ...data.nodes.map(n => n.fan_in));
  const elements = [];
  for (const n of data.nodes){
    const rec = n.file ? status[n.file] : null;
    const stale = !!(rec && rec.file_sha && n.last_commit && rec.file_sha !== n.last_commit);
    elements.push({ data: {
      id: n.id, label: n.id.split(/[./]/).filter(Boolean).pop().replace(/\.py$/, ""),
      file: n.file, fan_in: n.fan_in, fan_out: n.fan_out, cluster: n.cluster,
      color: _cbgClusterColor(n.cluster), review: _cbgReviewState(rec),
      findings_n: rec ? (rec.findings || 0) : 0, stale: stale,
    }});
  }
  for (const e of data.edges){
    elements.push({ data: { id: `${e.source}__${e.target}`, source: e.source, target: e.target } });
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
        "text-outline-width": 2, "text-outline-color": "#0a0f1a",
        "width": `mapData(fan_in, 0, ${maxFanIn}, 20, 74)`,
        "height": `mapData(fan_in, 0, ${maxFanIn}, 20, 74)`,
        "border-width": 2, "border-color": "rgba(255,255,255,.25)",
      }},
      { selector: 'node[review="findings"]', style: { "border-color": "#f66", "border-width": 4 } },
      { selector: 'node[review="clean"]', style: { "border-color": "#6e6", "border-width": 3 } },
      { selector: 'node[review="clean-hi"]', style: { "border-color": "#7f7", "border-width": 4 } },
      { selector: 'node[review="unreviewed"]', style: { "border-color": "rgba(120,130,160,.5)" } },
      { selector: "node[?stale]", style: { "border-style": "dashed" } },
      { selector: "edge", style: {
        "width": 1, "line-color": "rgba(150,180,220,.35)",
        "target-arrow-color": "rgba(150,180,220,.5)", "target-arrow-shape": "triangle",
        "arrow-scale": 0.7, "curve-style": "bezier",
      }},
      { selector: ".cbg-faded", style: { "opacity": 0.12 } },
      { selector: "node.cbg-hl", style: { "border-color": "var(--cyan,#5cf)" } },
      { selector: "edge.cbg-hl", style: {
        "line-color": "var(--cyan,#5cf)", "target-arrow-color": "var(--cyan,#5cf)",
        "width": 2, "opacity": 1 } },
    ],
    layout: {
      name: "concentric",
      concentric: n => n.data("fan_in"),
      levelWidth: () => Math.max(1, Math.round(maxFanIn / 6)),
      minNodeSpacing: 26, spacingFactor: 1.1, animate: false,
    },
  });

  cy.on("tap", "node", evt => _cbgSelect(panel, cy, evt.target));
  cy.on("tap", evt => { if (evt.target === cy){ cy.elements().removeClass("cbg-faded cbg-hl"); } });

  const pendingBox = panel.querySelector(".cbg-pending");
  pendingBox.addEventListener("change", () => {
    const clean = cy.nodes('[review="clean"], [review="clean-hi"], [review="reviewed"]');
    clean.style("display", pendingBox.checked ? "none" : "element");
  });

  const isoBox = panel.querySelector(".cbg-iso");
  isoBox.addEventListener("change", () => {
    const iso = cy.nodes().filter(n => n.degree(false) === 0);
    iso.style("display", isoBox.checked ? "none" : "element");
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
