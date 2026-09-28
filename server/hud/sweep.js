"use strict";
/* =============================== CODE SWEEP ===============================
   Front end for coder-engine's pipeline/sweep/sweep.py on snarf: a chunked,
   evidence-checked review of DARKHELIX with a persistent findings ledger.

   Start a sweep (whole repo or chosen directories), watch progress, and triage
   findings. Every finding's quote was verified to exist in the file; its CLAIM
   was not -- the model can still be wrong about what the code does. So nothing
   is filed on its own: "File issue" turns one finding into a GitHub issue
   (labelled from-sweep + an area), "False positive" / "Won't fix" retire it in
   the ledger so the next sweep is told and does not re-report it.

   A sweep takes the GPU seat for as long as it runs (the whole repo is an
   overnight job); the confirm dialog says so.
============================================================================ */

function swpEsc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
const SWP_SEV_CLASS = {critical: "err", high: "err", medium: "warn", low: ""};

function swpRow(f){
  return `<div class="swp-row" data-id="${swpEsc(f.id)}">
    <div class="swp-head">
      <span class="swp-sev ${SWP_SEV_CLASS[f.severity] || ""}">${swpEsc(f.severity)}</span>
      <span class="swp-cat">${swpEsc(f.category)}</span>
      <span class="swp-loc">${swpEsc(f.file)}:${swpEsc(f.line)}</span>
      ${f.issue ? `<a class="swp-issue" href="https://github.com/sbpannoni/DARKHELIX/issues/${f.issue}" target="_blank" rel="noopener">#${f.issue}</a>` : ""}
      <span class="swp-seen" title="times seen across sweeps">×${swpEsc(f.times_seen)}</span>
    </div>
    <div class="swp-summary">${swpEsc(f.summary)}</div>
    <details class="swp-more"><summary>evidence &amp; scenario</summary>
      <pre class="swp-quote">${swpEsc(f.quote)}</pre>
      <div class="swp-scenario">${swpEsc(f.failure_scenario)}</div>
      ${f.note ? `<div class="swp-note">note: ${swpEsc(f.note)}</div>` : ""}
    </details>
    ${f.status === "open" ? `<div class="swp-actions">
      <button class="btn swp-act" data-act="file_issue">File issue</button>
      <button class="btn swp-act" data-act="false_positive">False positive</button>
      <button class="btn swp-act" data-act="wontfix">Won't fix</button>
      <span class="swp-status"></span></div>` : `<div class="swp-actions"><span class="swp-state">${swpEsc(f.status)}</span></div>`}
  </div>`;
}

async function swpLoadStatus(panel){
  const bar = panel.querySelector(".swp-state-line");
  try{
    const r = await fetch("/api/sweep"); const j = await r.json();
    if(j.error){ bar.innerHTML = `<span class="err">${swpEsc(j.error)}</span>`; return; }
    const c = j.counts || {};
    bar.innerHTML = `${j.running ? '<span class="ok">● sweep running</span>' : '<span>idle</span>'}
      · open ${c.open || 0} · filed ${c.filed || 0} · false positive ${c.false_positive || 0}
      · won't fix ${c.wontfix || 0} · gone ${c.gone || 0}`;
    panel.querySelector(".swp-log").textContent = (j.log_tail || "").trim() || "(no sweep log yet)";
    const sel = panel.querySelector(".swp-scope");
    if(sel && !sel.dataset.filled && j.plan && j.plan.by_group){
      sel.innerHTML = `<option value="">whole repo — ${j.plan.chunks} chunks, ~${Math.round(j.plan.tokens / 1000)}K tokens</option>` +
        Object.entries(j.plan.by_group).map(([g, t]) =>
          `<option value="${swpEsc(g)}">${swpEsc(g)} — ~${Math.round(t / 1000)}K tokens</option>`).join("");
      sel.dataset.filled = "1";
    }
    panel.querySelector(".swp-start").disabled = !!j.running;
  }catch(err){ bar.innerHTML = `<span class="err">${swpEsc(err.message)}</span>`; }
}

async function swpLoadFindings(panel){
  const list = panel.querySelector(".swp-list");
  const status = panel.querySelector(".swp-filter").value;
  list.innerHTML = `<div class="swp-note">loading…</div>`;
  try{
    const r = await fetch(`/api/sweep/findings?status=${encodeURIComponent(status)}`); const j = await r.json();
    if(j.error){ list.innerHTML = `<div class="swp-note err">${swpEsc(j.error)}</div>`; return; }
    list.innerHTML = (j.findings || []).length ? j.findings.map(swpRow).join("")
      : `<div class="swp-note">No ${status === "all" ? "" : status + " "}findings in the ledger.</div>`;
  }catch(err){ list.innerHTML = `<div class="swp-note err">${swpEsc(err.message)}</div>`; }
}

async function swpStart(panel){
  const scope = panel.querySelector(".swp-scope").value;
  const what = scope ? scope : "the WHOLE repo (an overnight job)";
  if(!confirm(`Sweep ${what}? It takes snarf's GPU seat until it finishes; other model work waits.`)) return;
  const r = await fetch("/api/sweep/start", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({only: scope ? [scope] : null})});
  const j = await r.json();
  if(!j.ok) alert(j.error || "could not start");
  setTimeout(() => swpLoadStatus(panel), 1500);
}

async function swpAct(panel, row, act){
  const st = row.querySelector(".swp-status");
  st.textContent = act === "file_issue" ? "filing…" : "saving…";
  try{
    const r = await fetch("/api/sweep/finding", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({id: row.dataset.id, action: act})});
    const j = await r.json();
    if(!j.ok){ st.innerHTML = `<span class="err">${swpEsc(j.error || "failed")}</span>`; return; }
    st.innerHTML = act === "file_issue"
      ? `<span class="ok">filed <a href="${swpEsc(j.url)}" target="_blank" rel="noopener">#${swpEsc(j.issue)}</a></span>`
      : `<span class="ok">${act.replace("_", " ")}</span>`;
    row.querySelectorAll(".swp-act").forEach(b => b.disabled = true);
    swpLoadStatus(panel);
  }catch(err){ st.innerHTML = `<span class="err">${swpEsc(err.message)}</span>`; }
}

function openCodeSweep(){
  openWorkTabTurning("sweep", "main", "CODE SWEEP", (panel) => {
    panel.classList.add("swp-pane");
    panel.innerHTML = `
      <div class="swp-bar">
        <span class="swp-bar-title">CODE SWEEP</span>
        <span class="swp-state-line">…</span>
        <span class="swp-spacer"></span>
        <select class="swp-scope" title="What to sweep"><option>loading plan…</option></select>
        <button class="btn swp-start">▶ start sweep</button>
        <select class="swp-filter" title="Which findings to show">
          <option value="open">open</option><option value="filed">filed</option>
          <option value="false_positive">false positive</option><option value="wontfix">won't fix</option>
          <option value="gone">gone (quote no longer in file)</option><option value="all">all</option>
        </select>
        <button class="btn swp-reload">⟲</button>
      </div>
      <pre class="swp-log"></pre>
      <div class="swp-list"></div>`;
    panel.querySelector(".swp-start").onclick = () => swpStart(panel);
    panel.querySelector(".swp-reload").onclick = () => { swpLoadStatus(panel); swpLoadFindings(panel); };
    panel.querySelector(".swp-filter").onchange = () => swpLoadFindings(panel);
    panel.querySelector(".swp-list").addEventListener("click", (e) => {
      const b = e.target.closest(".swp-act"); if(!b) return;
      swpAct(panel, b.closest(".swp-row"), b.dataset.act);
    });
    swpLoadStatus(panel); swpLoadFindings(panel);
    const t = setInterval(() => { if(!document.body.contains(panel)) return clearInterval(t); swpLoadStatus(panel); }, 20000);
  });
}

document.querySelectorAll('[data-action="code-sweep"]').forEach(b => b.addEventListener("click", openCodeSweep));
