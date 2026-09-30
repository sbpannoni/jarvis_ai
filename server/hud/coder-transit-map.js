"use strict";
/* ======================== CODER-ENGINE TRANSIT MAP ======================
   Subway-style diagram of every role the coder-engine pipeline needs a
   model for: Editor (live), Reviewer (live, new), Orchestrator (native
   Hermes mechanism, unevaluated). Data comes from /api/coder-transit-map,
   which combines the same editor metrics /api/coder-models reads with a
   new reviewer-metrics file -- both refreshed by coder_models_refresh.py
   on claude-control (CT110). See that endpoint's docstring in server.py.

   Line colors deliberately reuse existing HUD semantics rather than
   inventing a new palette: --cyan is already this dashboard's coder-engine
   accent (CODER MODELS panel), --magenta already means "agent work +
   Claude" (the human/Claude review pairing this Reviewer line is meant to
   offload), --amber already means kanban/task-work (fits Orchestrator's
   task-decomposition role). Station status dots stay teal=good/
   orange=native-but-unevaluated/dim=not-built, matching .dot.on elsewhere.

   Station labels are horizontal, centered, wrapped to at most two lines of
   ~12 characters so each fits inside the 140px station spacing. (They were
   angled until 2026-09-27; at this spacing the diagonals ran into the next
   row's labels and the metric text.) Editor labels sit above their line,
   reviewer and orchestrator labels below theirs, and each line's title +
   metrics sit in the open band on the other side of it -- so no row's text
   is ever drawn into another row's.

   Mirrors coder-models.js's fetch -> render -> poll shape and
   openWorkTabTurning shell.
================================================================= */

function transitFmtPct(x){ return x == null ? "—" : Math.round(x * 100) + "%"; }
function transitFmtTime(x){ return x == null ? "—" : x + "s"; }

// Performance heatmap for card borders: red (0) -> amber -> teal (1). Null
// (no data yet) stays the neutral line color -- absence isn't "bad", it's
// unmeasured, and shouldn't read as a red flag next to real low scores.
function transitHeatColor(value){
  if (value == null) return "var(--line)";
  const v = Math.max(0, Math.min(1, value));
  const hue = v * 150; // 0=red, ~40=amber, 150=teal-green
  return `hsl(${hue}, 78%, 52%)`;
}

function transitStationDot(status){
  if (status === "good") return `<circle class="tm-station-dot" r="4" fill="var(--teal)"/>`;
  if (status === "warn") return `<circle class="tm-station-dot" r="4" fill="var(--orange)"/>`;
  return "";
}

function transitStationCircle(cx, cy, lineColorVar, status){
  const dashed = status === "none" ? ' stroke-dasharray="2 4"' : "";
  const fill = status === "none" ? "var(--bg)" : "var(--panel)";
  return `<circle cx="${cx}" cy="${cy}" r="8" fill="${fill}" stroke="${lineColorVar}" stroke-width="3"${dashed}/>
          <g transform="translate(${cx},${cy})">${transitStationDot(status)}</g>`;
}

// Horizontal station label, centered on the stop, word-wrapped to lines of
// <= TRANSIT_LABEL_CHARS so neighbors 140px apart never touch. "above"
// stacks upward from just over the station; "below" stacks downward.
const TRANSIT_LABEL_CHARS = 12;
const TRANSIT_LABEL_LINE = 13;
function transitStationLabel(cx, cy, text, pos){
  const lines = [];
  for (const word of text.split(" ")){
    const last = lines[lines.length - 1];
    if (last != null && (last + " " + word).length <= TRANSIT_LABEL_CHARS) lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  const first = pos === "above"
    ? cy - 16 - (lines.length - 1) * TRANSIT_LABEL_LINE
    : cy + 28;
  return `<text text-anchor="middle" class="tm-station-label">${lines.map((l, i) =>
    `<tspan x="${cx}" y="${first + i * TRANSIT_LABEL_LINE}">${l}</tspan>`).join("")}</text>`;
}

function transitMetricChip(x, y, text, color){
  return `<text x="${x}" y="${y}" text-anchor="start" class="tm-metric-chip" fill="${color||'var(--txt-dim)'}">${text}</text>`;
}

// Each line's text leads with the model ASSIGNED to that role (from
// /api/model-role-assignments) and its own eval numbers -- or "not yet
// evaluated" when the eval files predate it (the llama.cpp models, for one).
// It used to show only the leaderboard's top scorer, so reassigning a role
// changed nothing on the map. The top scorer is still shown underneath when
// it isn't the assigned model.
function transitLineText(models, assignedId, roster, fmt, isMeasured, noun){
  const measured = (models || []).filter(isMeasured);
  const rosterEntry = (roster || []).find(m => m.id === assignedId);
  const assigned = (models || []).find(m => m.id === assignedId);
  const label = (assigned || rosterEntry || {}).label || assignedId;
  const main = !assignedId
    ? {text: "no model assigned", color: "var(--txt-dim)"}
    : assigned && isMeasured(assigned)
      ? {text: `${label.toUpperCase()} ${fmt(assigned)}`, color: "var(--teal)"}
      : {text: `${label.toUpperCase()} — not yet evaluated`, color: "var(--orange)"};
  const top = measured[0];
  const sub = top && top.id !== assignedId
    ? `best measured: ${top.label} ${fmt(top)} · ${measured.length} ${noun}`
    : `${measured.length} ${noun}`;
  return {main, sub};
}

function buildTransitSvg(data, roleData){
  const assignments = (roleData && roleData.assignments) || {};
  const roster = (roleData && roleData.roster) || [];

  const ed = transitLineText(data.editor.models, assignments.editor, roster,
    m => `${transitFmtPct(m.pass_rate)} · ${transitFmtTime(m.avg_elapsed_s)}`,
    m => m.total_runs > 0, "candidates measured");
  const editorChip = transitMetricChip(440, 88, ed.main.text, ed.main.color);
  const editorSub = transitMetricChip(440, 102, ed.sub, "var(--txt-dim)");

  const reviewGraded = (data.reviewer.models || []).filter(m => m.graded_count > 0);
  const rv = transitLineText(data.reviewer.models, assignments.reviewer, roster,
    m => `${transitFmtPct(m.catch_rate)} catch · ${transitFmtPct(m.false_positive_rate)} FP`,
    m => m.graded_count > 0, "candidates graded");
  const reviewChip = transitMetricChip(440, 258, rv.main.text, rv.main.color);
  const reviewSub = transitMetricChip(440, 272, rv.sub, "var(--txt-dim)");

  const orchGraded = (data.orchestrator.models || []).filter(m => m.graded_count > 0);
  const or = transitLineText(data.orchestrator.models, assignments.orchestrator, roster,
    m => `${transitFmtPct(m.coverage_rate)} coverage`,
    m => m.graded_count > 0, "candidates graded");
  const orchChip = transitMetricChip(440, 404, or.main.text, or.main.color);
  const orchSub = transitMetricChip(440, 418, or.sub, "var(--txt-dim)");

  const reviewerHasData = reviewGraded.length > 0;
  const reviewerStationStatus = reviewerHasData ? "good" : "none";
  const reviewerLineDash = reviewerHasData ? "" : ' stroke-dasharray="2 14"';
  const orchStationStatus = orchGraded.length > 0 ? "good" : "warn";

  return `
  <svg viewBox="0 45 1300 460" role="img" class="tm-svg" aria-label="Transit-style diagram of the coder-engine pipeline: a shared Kanban-and-Dispatch trunk splits into an Editor line, a Reviewer line, and an Orchestrator line, reconverging at this HUD.">

    <g stroke="var(--line)" stroke-width="1" opacity="0.5">
      <line x1="40" y1="150" x2="1260" y2="150"/>
      <line x1="40" y1="300" x2="1260" y2="300"/>
      <line x1="40" y1="450" x2="1260" y2="450"/>
    </g>

    <g fill="none" stroke-width="6" stroke-linecap="round">
      <path d="M 80 292 L 280 292" stroke="var(--cyan)"/>
      <path d="M 80 300 L 280 300" stroke="var(--magenta)"/>
      <path d="M 80 308 L 280 308" stroke="var(--amber)"/>
    </g>

    <g fill="none" stroke="var(--cyan)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 280 292 L 310 292 L 420 150 L 1060 150 L 1170 270 L 1200 292"/>
    </g>

    <g fill="none" stroke="var(--amber)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 280 308 L 310 308 L 420 450 L 1060 450 L 1170 330 L 1200 308"/>
    </g>

    <g fill="none" stroke="var(--magenta)" stroke-width="6" stroke-linecap="round"${reviewerLineDash}>
      <path d="M 280 300 L 1200 300"/>
    </g>

    <g fill="none" stroke-width="6" stroke-linecap="round">
      <path d="M 1200 292 L 1250 292" stroke="var(--cyan)"/>
      <path d="M 1200 300 L 1250 300" stroke="var(--magenta)"/>
      <path d="M 1200 308 L 1250 308" stroke="var(--amber)"/>
    </g>

    <text x="440" y="70" class="tm-line-tag" fill="var(--cyan)">EDITOR — LIVE</text>
    <text x="440" y="240" class="tm-line-tag" fill="var(--magenta)">REVIEWER — ${reviewerHasData ? "LIVE" : "NOT BUILT"}</text>
    <text x="440" y="386" class="tm-line-tag" fill="var(--amber)">ORCHESTRATOR — NATIVE, ${orchGraded.length > 0 ? "BENCHMARKED" : "UNTESTED"}</text>

    <circle cx="80" cy="300" r="12" fill="var(--panel)" stroke="var(--txt)" stroke-width="3"/>
    <circle cx="80" cy="300" r="4" fill="var(--teal)"/>
    ${transitStationLabel(80, 300, "KANBAN BOARD", "below")}

    <circle cx="280" cy="300" r="12" fill="var(--panel)" stroke="var(--txt)" stroke-width="3"/>
    <circle cx="280" cy="300" r="4" fill="var(--teal)"/>
    ${transitStationLabel(280, 300, "CLAIM + DISPATCH", "below")}

    ${transitStationCircle(560, 150, "var(--cyan)", "good")}
    ${transitStationLabel(560, 150, "WORKTREE + BRANCH", "above")}

    ${transitStationCircle(700, 150, "var(--cyan)", "good")}
    ${transitStationLabel(700, 150, "DOCKER: EDIT (AIDER)", "above")}
    ${editorChip}${editorSub}

    ${transitStationCircle(840, 150, "var(--cyan)", "good")}
    ${transitStationLabel(840, 150, "TEST GATE", "above")}

    ${transitStationCircle(980, 150, "var(--cyan)", "good")}
    ${transitStationLabel(980, 150, "COMMIT + PATCH", "above")}

    ${transitStationCircle(560, 450, "var(--amber)", orchStationStatus)}
    ${transitStationLabel(560, 450, "TASK INTAKE", "below")}

    ${transitStationCircle(700, 450, "var(--amber)", orchStationStatus)}
    ${transitStationLabel(700, 450, "MODEL: DECOMPOSE", "below")}
    ${orchChip}${orchSub}

    ${transitStationCircle(840, 450, "var(--amber)", orchStationStatus)}
    ${transitStationLabel(840, 450, "DEPENDENCY GRAPH", "below")}

    ${transitStationCircle(980, 450, "var(--amber)", orchStationStatus)}
    ${transitStationLabel(980, 450, "KANBAN: CHILD TASKS", "below")}

    ${transitStationCircle(560, 300, "var(--magenta)", reviewerStationStatus)}
    ${transitStationLabel(560, 300, "WORKTREE INJECT", "below")}

    ${transitStationCircle(700, 300, "var(--magenta)", reviewerStationStatus)}
    ${transitStationLabel(700, 300, "MODEL: ANALYZE", "below")}
    ${reviewChip}${reviewSub}

    ${transitStationCircle(840, 300, "var(--magenta)", reviewerStationStatus)}
    ${transitStationLabel(840, 300, "FINDINGS REPORT", "below")}

    <circle cx="980" cy="300" r="8" fill="var(--bg)" stroke="var(--magenta)" stroke-width="3" stroke-dasharray="2 4"/>
    ${transitStationLabel(980, 300, "KANBAN: TRIAGE CARD", "below")}

    <circle cx="1200" cy="300" r="12" fill="var(--panel)" stroke="var(--txt)" stroke-width="3"/>
    <circle cx="1200" cy="300" r="4" fill="var(--teal)"/>
    ${transitStationLabel(1232, 300, "RESULT", "below")}
  </svg>`;
}

function transitModelCard(m, kind){
  const heat = kind === "editor" ? transitHeatColor(m.pass_rate) : transitHeatColor(m.catch_rate);
  const style = `border-top-color:${heat}`;
  if (kind === "editor"){
    return `<div class="mcard" style="${style}">
      <div class="mcard-head"><b>${m.label}</b></div>
      <div class="mcard-metrics">
        <div class="mcard-metric-row"><span>pass rate</span><b>${transitFmtPct(m.pass_rate)}</b></div>
        <div class="mcard-metric-row"><span>avg time</span><b>${transitFmtTime(m.avg_elapsed_s)}</b></div>
        <div class="mcard-metric-row"><span>runs</span><b>${m.total_runs}</b></div>
      </div>
    </div>`;
  }
  const graded = m.graded_count > 0;
  return `<div class="mcard" style="${style}">
    <div class="mcard-head"><b>${m.label}</b></div>
    <div class="mcard-metrics">
      ${graded ? `
        <div class="mcard-metric-row"><span>catch rate</span><b>${transitFmtPct(m.catch_rate)}</b></div>
        <div class="mcard-metric-row"><span>false-positive rate</span><b>${transitFmtPct(m.false_positive_rate)}</b></div>
        <div class="mcard-metric-row"><span>graded</span><b>${m.graded_count}</b></div>
      ` : `<div class="mcard-metrics mcard-none">${m.raw_reviews_captured} captured, not yet graded</div>`}
    </div>
  </div>`;
}

// The leaderboard cards come only from the eval files, so a role's ASSIGNED
// model with no eval runs (the llama.cpp models) had no card at all. Lead
// each line with the assigned model: its own card tagged ASSIGNED if it has
// been measured, or a placeholder card if not.
function transitAssignedFirst(cards, models, assignedId, roster, cardFn){
  if (!assignedId) return cards.join("");
  const idx = (models || []).findIndex(m => m.id === assignedId);
  if (idx >= 0){
    const tagged = cards[idx].replace('<div class="mcard-head"><b>', '<div class="mcard-head"><span class="mcard-assigned">ASSIGNED</span><b>');
    return [tagged, ...cards.filter((_, i) => i !== idx)].join("");
  }
  const entry = (roster || []).find(m => m.id === assignedId) || {};
  const backend = entry.backend ? ` · ${entry.backend === "llamacpp" ? "llama.cpp" : entry.backend}` : "";
  return `<div class="mcard mcard-unevaluated">
      <div class="mcard-head"><span class="mcard-assigned">ASSIGNED</span><b>${entry.label || assignedId}</b></div>
      <div class="mcard-metrics mcard-none">not yet evaluated${backend} — no eval runs in the current metrics files</div>
    </div>` + cards.join("");
}

function transitOrchestratorCard(m){
  const heat = transitHeatColor(m.coverage_rate);
  const style = `border-top-color:${heat}`;
  const graded = m.graded_count > 0;
  return `<div class="mcard" style="${style}">
    <div class="mcard-head"><b>${m.label}</b></div>
    <div class="mcard-metrics">
      ${graded ? `
        <div class="mcard-metric-row"><span>coverage</span><b>${transitFmtPct(m.coverage_rate)} (${m.items_covered}/${m.items_total})</b></div>
        <div class="mcard-metric-row"><span>ordering sound</span><b>${m.ordering_sound_count}/${m.graded_count}</b></div>
        <div class="mcard-metric-row"><span>invented extra work</span><b>${m.invented_unnecessary_work_count}/${m.graded_count}</b></div>
      ` : `<div class="mcard-metrics mcard-none">${m.raw_plans_captured} captured, not yet graded</div>`}
    </div>
  </div>`;
}

function transitRoleOptions(roster, selected){
  // A model with tool_calling === false (from CODER_MODELS_ROSTER via
  // /api/model-role-assignments) can't emit structured tool calls, so it can't
  // fill any role -- render it disabled with a visible reason. The server
  // rejects it too (POST guard), since this endpoint is callable directly.
  // Grouped by model-seat backend; "●" marks the model currently in the GPU
  // seat. Catalog models with no CODER_MODELS_ROSTER entry (unverified) are
  // listed so a new unit is visible, but disabled until tool calling is
  // verified -- the server's POST guard rejects them too.
  const option = m => {
    const noTools = m.tool_calling === false;
    const why = m.unverified ? " — not in roster, tool calls unverified"
      : noTools ? " — no tool calls (can't be assigned)"
      : m.in_seat_catalog === false ? " — not installed in model-seat" : "";
    const label = `${m.loaded ? "● " : ""}${m.label}${why}`;
    return `<option value="${m.id}"${m.id === selected ? " selected" : ""}`
      + `${noTools || m.unverified ? " disabled" : ""}>${label}</option>`;
  };
  const groups = {};
  (roster || []).forEach(m => { (groups[m.backend || "other"] ||= []).push(m); });
  const order = ["vllm", "llamacpp", "other"];
  const names = {vllm: "vLLM", llamacpp: "llama.cpp", other: "not in model-seat"};
  const keys = Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (keys.length === 1) return groups[keys[0]].map(option).join("");
  return keys.map(k => `<optgroup label="${names[k] || k}">${groups[k].map(option).join("")}</optgroup>`).join("");
}

// All three roles run on snarf's single GPU seat (model-seat), so roles on
// different models mean a cold swap every time the pipeline hands off between
// them -- minutes for a large llama.cpp model. Say so next to the dropdowns.
function transitSeatWarning(panel, roster){
  const el = panel.querySelector(".tm-seat-warning");
  if (!el) return;
  const byId = Object.fromEntries((roster || []).map(m => [m.id, m]));
  const picks = [...panel.querySelectorAll(".tm-role-select")].map(sel => sel.value);
  const distinct = [...new Set(picks)];
  if (distinct.length <= 1){ el.textContent = ""; el.hidden = true; return; }
  const heavy = distinct.filter(id => (byId[id] || {}).backend === "llamacpp");
  el.hidden = false;
  el.textContent = `⚠ ${distinct.length} different models share one GPU seat — every role hand-off is a cold swap`
    + (heavy.length ? ` (${heavy.map(id => (byId[id] || {}).label || id).join(", ")} on llama.cpp loads slowest)` : "")
    + ". Assign the same model to roles that run back-to-back to avoid it.";
}

// Dropdown bar surfacing the model actually configured per role and
// letting it be changed live -- separate from the leaderboard cards below,
// which rank candidates by eval score but don't say what's actually set.
// Backed by model_role_assignments.json on snarf (see server.py's
// /api/model-role-assignments docstring). The LIVE/NOT WIRED tag comes from
// the server's live_roles, so it says which changes take effect on the next
// dispatch vs. are only recorded.
// Editable per-model reasoning tuning shown inline on the editor/reviewer
// rows (the two roles whose model reads model_tuning.json via reviewer_prompt).
// Keyed by MODEL, not role: if two roles share a model, both rows edit the same
// underlying entry. Only budget + effort are exposed here -- sampling is a
// deeper per-model value managed in the file. A model with no tuning profile
// yet renders disabled (its sampling must be seeded first).
function transitTuningControl(model, t){
  if (!model) return "";
  const known = !!(t && typeof t.think_budget_tokens === "number");
  const budget = known ? t.think_budget_tokens : "";
  const effort = (t && t.reasoning_effort) ? t.reasoning_effort : "default";
  const dis = known ? "" : " disabled";
  const efOpts = ["default", "low", "medium", "high", "max"]
    .map(e => `<option value="${e}"${e === effort ? " selected" : ""}>${e}</option>`).join("");
  return `<span class="tm-tune" data-tune-model="${model}"${known ? "" : ' title="no tuning profile; seed sampling in model_tuning.json first"'}>
    <label class="tm-tune-lbl">budget</label>
    <input class="tm-tune-budget" type="number" min="1000" max="200000" step="1000" value="${budget}"${dis}>
    <label class="tm-tune-lbl">effort</label>
    <select class="tm-tune-effort"${dis}>${efOpts}</select>
    <button class="tm-tune-save"${dis}>set</button>
    <span class="tm-tune-status"></span>
  </span>`;
}

async function saveModelTuning(model, budget, effort, statusEl){
  statusEl.textContent = "saving…";
  statusEl.className = "tm-tune-status";
  try{
    const r = await fetch("/api/model-tuning", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        model,
        think_budget_tokens: budget,
        reasoning_effort: (effort === "default") ? null : effort,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    statusEl.textContent = "saved";
    statusEl.className = "tm-tune-status saved";
    setTimeout(() => { statusEl.textContent = ""; }, 2500);
  }catch(err){
    statusEl.textContent = `error: ${err.message}`;
    statusEl.className = "tm-tune-status err";
  }
}

function transitRoleBar(roleData){
  const roster = roleData.roster || [];
  const assignments = roleData.assignments || {};
  const live = new Set(roleData.live_roles || []);
  const tuning = roleData.tuning || {};
  const roles = [["editor", "EDITOR"], ["reviewer", "REVIEWER"], ["orchestrator", "ORCHESTRATOR"]];
  return `<div class="tm-role-bar">${roles.map(([key, label]) => `
    <div class="tm-role-item">
      <span class="tm-role-label">${label}</span>
      <select class="tm-role-select" data-role="${key}">${transitRoleOptions(roster, assignments[key])}</select>
      <span class="${live.has(key) ? "tm-role-live" : "tm-role-notlive"}">${live.has(key) ? "LIVE" : "NOT WIRED"}</span>
      <span class="tm-role-status" data-role-status="${key}"></span>
      ${(key === "editor" || key === "reviewer") ? transitTuningControl(assignments[key], tuning[assignments[key]]) : ""}
    </div>`).join("")}
  </div>
  <div class="tm-seat-warning" hidden></div>`;
}

async function saveRoleAssignment(role, model, statusEl){
  statusEl.textContent = "saving…";
  statusEl.className = "tm-role-status";
  try{
    const r = await fetch("/api/model-role-assignments", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({role, model}),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    statusEl.textContent = "saved";
    statusEl.className = "tm-role-status saved";
    setTimeout(() => { statusEl.textContent = ""; }, 2500);
  }catch(err){
    statusEl.textContent = `error: ${err.message}`;
    statusEl.className = "tm-role-status err";
  }
}

// Redraw just the SVG with the new assignment, so the line text tracks the
// dropdown immediately instead of on the next full panel render.
function transitRefreshSvg(panel, role, model){
  const st = panel._transit;
  if (!st) return;
  st.roleData.assignments = {...(st.roleData.assignments || {}), [role]: model};
  const wrap = panel.querySelector(".tm-svg-wrap");
  if (wrap) wrap.innerHTML = buildTransitSvg(st.data, st.roleData);
}

function wireRoleBar(panel, roster){
  transitSeatWarning(panel, roster);
  panel.querySelectorAll(".tm-role-select").forEach(sel => {
    sel.addEventListener("change", () => {
      transitSeatWarning(panel, roster);
      const role = sel.dataset.role;
      transitRefreshSvg(panel, role, sel.value);
      const statusEl = panel.querySelector(`[data-role-status="${role}"]`);
      saveRoleAssignment(role, sel.value, statusEl);
    });
  });
  panel.querySelectorAll(".tm-tune").forEach(box => {
    const btn = box.querySelector(".tm-tune-save");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const model = box.dataset.tuneModel;
      const budget = parseInt(box.querySelector(".tm-tune-budget").value, 10);
      const effort = box.querySelector(".tm-tune-effort").value;
      const statusEl = box.querySelector(".tm-tune-status");
      if (!Number.isFinite(budget)){
        statusEl.textContent = "budget?";
        statusEl.className = "tm-tune-status err";
        return;
      }
      saveModelTuning(model, budget, effort, statusEl);
    });
  });
}

// One-click trigger for the reviewer role's real live path (POST
// /api/review-file -> dispatch_review_task.py on snarf -> a --triage
// kanban card, never a higher status). One call = one review; no polling
// loop needed, the request itself blocks until the review (and card
// filing) completes or fails.
//
// The "chain" checkbox (2026-09-26) opts into review-file's chain:true --
// when the review actually finds something, this ALSO files a second,
// normally-dispatchable [Fix] card (--parent-linked, assignee=coder) for
// the editor to pick up on its own. Off by default: this is the one
// action in this whole panel that can cause real, unsupervised code
// changes, so a human ticks it on purpose rather than it being the
// default click.
function wireReviewTrigger(panel){
  const btn = panel.querySelector(".tm-review-btn");
  const input = panel.querySelector(".tm-review-input");
  const chainBox = panel.querySelector(".tm-review-chain");
  const modeSel = panel.querySelector(".tm-review-mode");
  const statusEl = panel.querySelector(".tm-review-status");
  if (!btn || !input || !statusEl) return;
  btn.addEventListener("click", async () => {
    const target_file = input.value.trim();
    if (!target_file){ statusEl.textContent = "enter a file path first"; statusEl.className = "tm-review-status err"; return; }
    const chain = !!(chainBox && chainBox.checked);
    btn.disabled = true;
    statusEl.textContent = "reviewing… (can take a minute or two)";
    statusEl.className = "tm-review-status";
    try{
      const r = await fetch("/api/review-file", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({target_file, chain, mode: modeSel ? modeSel.value : "sweep"}),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.no_issues_found){
        statusEl.textContent = `filed to triage: ${j.task.id} (no issues found)`;
        statusEl.className = "tm-review-status saved";
      } else if (j.chained){
        statusEl.textContent = `review ${j.task.id} -> fix card ${j.chained_task.id} filed (todo, assignee ${j.chained_task.assignee})`;
        statusEl.className = "tm-review-status saved";
      } else if (chain){
        statusEl.textContent = `filed to triage: ${j.task.id} (${j.chain_skipped_reason || "not chained"})`;
        statusEl.className = "tm-review-status saved";
      } else {
        statusEl.textContent = `filed to triage: ${j.task.id}`;
        statusEl.className = "tm-review-status saved";
      }
    }catch(err){
      statusEl.textContent = `error: ${err.message}`;
      statusEl.className = "tm-review-status err";
    }finally{
      btn.disabled = false;
    }
  });
}

// Manual trigger for the review chain's orchestration endpoint: given a
// completed [Fix] card's id, runs the mechanical gates and (if they pass)
// closure-review, then ACTS -- accept (leaves it for a human to merge),
// retry (files a new linked attempt with specific objections), or
// escalate (hermes kanban block --kind needs_input). Manual by design:
// this is the one control in the panel that can file new work or change
// a card's board state, so it stays a deliberate click, not a background
// sweep, until there's been enough supervised use to trust it unattended.
//
// The "auto-land" checkbox (2026-09-27) is the override toggle: when an
// accept verdict lands, this also carries it through PR submit, CI wait,
// and merge, instead of stopping at "ready for a human". Off by default
// per-click here regardless of the server.yaml review_chain.auto_land
// default, for the same reason chain defaults off on the review trigger
// above -- the one action that can merge to master unattended stays an
// explicit, visible opt-in, not a box someone leaves checked and forgets.
function wireProcessFixCardTrigger(panel){
  const btn = panel.querySelector(".tm-process-btn");
  const input = panel.querySelector(".tm-process-input");
  const autoLandBox = panel.querySelector(".tm-process-autoland");
  const statusEl = panel.querySelector(".tm-process-status");
  if (!btn || !input || !statusEl) return;
  btn.addEventListener("click", async () => {
    const task_id = input.value.trim();
    if (!task_id){ statusEl.textContent = "enter a fix card id first"; statusEl.className = "tm-process-status err"; return; }
    const auto_land = !!(autoLandBox && autoLandBox.checked);
    btn.disabled = true;
    statusEl.textContent = auto_land
      ? "checking gates, may run closure-review, then PR+CI+merge if accepted…"
      : "checking gates, may run closure-review…";
    statusEl.className = "tm-process-status";
    try{
      const r = await fetch("/api/kanban/process-fix-card", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({task_id, auto_land}),
      });
      const j = await r.json();
      const byAction = {accept: "saved", retry: "warn", escalate: "err"};
      if (j.action === "accept" && j.auto_land){
        const land = j.auto_land;
        statusEl.textContent = land.ok
          ? `accept -> merged: ${land.pr_url || ""}`
          : `accept -> land failed at ${land.stage}: ${land.reason || land.error || "unknown"}`;
        statusEl.className = `tm-process-status ${land.ok ? "saved" : "err"}`;
      } else if (!j.ok){
        throw new Error(j.error || j.escalate_error || `HTTP ${r.status}`);
      } else {
        statusEl.textContent = `${j.action} (attempt ${j.attempt}): ${j.reason}`
          + (j.retry_task ? ` -> ${j.retry_task.id}` : "");
        statusEl.className = `tm-process-status ${byAction[j.action] || ""}`;
      }
    }catch(err){
      statusEl.textContent = `error: ${err.message}`;
      statusEl.className = "tm-process-status err";
    }finally{
      btn.disabled = false;
    }
  });
}

async function renderTransitMap(panel){
  try{
    const [r, roleR, tuneR] = await Promise.all([
      fetch("/api/coder-transit-map"),
      fetch("/api/model-role-assignments"),
      fetch("/api/model-tuning"),
    ]);
    const j = await r.json();
    const roleData = roleR.ok ? await roleR.json() : {roster: [], assignments: {}, live_roles: []};
    roleData.tuning = tuneR.ok ? ((await tuneR.json()).tuning || {}) : {};
    const editorGen = j.editor.generated_at ? new Date(j.editor.generated_at).toLocaleString() : "never";
    const reviewGen = j.reviewer.generated_at ? new Date(j.reviewer.generated_at).toLocaleString() : "never";
    const orchGen = j.orchestrator.generated_at ? new Date(j.orchestrator.generated_at).toLocaleString() : "never";

    const asg = roleData.assignments || {};
    const editorCards = transitAssignedFirst((j.editor.models || []).map(m => transitModelCard(m, "editor")),
      j.editor.models, asg.editor, roleData.roster);
    const reviewerCards = transitAssignedFirst((j.reviewer.models || []).map(m => transitModelCard(m, "reviewer")),
      j.reviewer.models, asg.reviewer, roleData.roster);
    const orchCards = transitAssignedFirst((j.orchestrator.models || []).map(transitOrchestratorCard),
      j.orchestrator.models, asg.orchestrator, roleData.roster);

    panel.innerHTML = `
      <div class="flow-head-bar">CODER-ENGINE TRANSIT MAP — editor ${editorGen}, reviewer ${reviewGen}, orchestrator ${orchGen}</div>
      ${transitRoleBar(roleData)}
      <div class="tm-svg-wrap">${buildTransitSvg(j, roleData)}</div>
      <details class="tm-line-section">
        <summary class="flow-head-bar">EDITOR LINE — ranked by pass rate</summary>
        <div class="flow-grid mcard-grid">${editorCards || '<div class="kv"><span>no runs yet</span></div>'}</div>
      </details>
      <details class="tm-line-section">
        <summary class="flow-head-bar">REVIEWER LINE — ranked by catch rate</summary>
        <div class="tm-review-trigger">
          <input type="text" class="tm-review-input" placeholder="path inside DARKHELIX, e.g. darkhelix/ui_registry.py" />
          <label class="tm-review-chain-label" title="Also file a linked, dispatchable [Fix] card if the review finds something -- runs unsupervised once filed">
            <input type="checkbox" class="tm-review-chain" /> chain
          </label>
          <select class="tm-review-mode" title="sweep = breadth only (fast); deep = a deep pass when the sweep comes back clean"><option value="sweep">sweep</option><option value="deep">deep (on clean)</option></select>
          <button type="button" class="btn tm-review-btn">RUN REVIEW</button>
          <span class="tm-review-status"></span>
        </div>
        <div class="tm-process-trigger">
          <input type="text" class="tm-process-input" placeholder="[Fix] card id, e.g. t_abcd1234" />
          <label class="tm-review-chain-label" title="If accepted, also carry it through PR submit, CI wait, and merge -- otherwise accept just leaves it ready for a human">
            <input type="checkbox" class="tm-process-autoland" /> auto-land
          </label>
          <button type="button" class="btn tm-process-btn">PROCESS FIX CARD</button>
          <span class="tm-process-status"></span>
        </div>
        <div class="flow-grid mcard-grid">${reviewerCards || '<div class="kv"><span>no runs yet</span></div>'}</div>
      </details>
      <details class="tm-line-section">
        <summary class="flow-head-bar">ORCHESTRATOR LINE — ranked by coverage rate</summary>
        <div class="flow-grid mcard-grid">${orchCards || '<div class="kv"><span>no runs yet</span></div>'}</div>
        <div class="kv" style="padding:6px 10px"><span style="color:var(--txt-dim); font-size:11px">${j.orchestrator.note}</span></div>
      </details>
    `;
    panel._transit = {data: j, roleData};
    wireRoleBar(panel, roleData.roster);
    wireReviewTrigger(panel);
    wireProcessFixCardTrigger(panel);
  }catch(err){
    panel.innerHTML = `<div class="kv"><span class="err">transit map unavailable: ${err.message}</span></div>`;
  }
}

function openCoderTransitMap(){
  openWorkTabTurning("coder-transit-map","main","TRANSIT MAP",(panel,tab)=>{
    panel.innerHTML = `<div class="kv"><span>loading…</span></div>`;
    panel.classList.add("flow-pane");
    renderTransitMap(panel);
    const iv = setInterval(()=>renderTransitMap(panel), 30000);
    tab.onBeforeClose = () => clearInterval(iv);
  });
}

document.querySelectorAll('[data-action="coder-transit-map"]').forEach(b=>b.addEventListener("click", openCoderTransitMap));
