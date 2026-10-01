/* ============================== RESEARCH =================================
   The docs/research/ decision log, parsed from each record's YAML front-matter
   via GET /api/darkhelix/research. Browse/query the findings research cards
   captured ("⎘ Research" on a done card) when planning a feature or upgrade.
   Records are machine-readable and committed to the DARKHELIX repo; this is just
   the read surface. Depends on openWorkTabTurning + openTaskLog from app.js. */
function rsEsc(s){ return (s || "").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])); }

function rsRow(r){
  const st = (r.status || "proposed").toLowerCase();
  const card = /^t_[0-9a-f]+$/.test(r.card_id || "")
    ? `<a href="#" class="rs-card" data-card="${rsEsc(r.card_id)}" title="open this record's source card">${rsEsc(r.card_id)}</a>` : "";
  const tags = (r.tags && r.tags !== "[]") ? `<span class="rs-tags">${rsEsc(r.tags)}</span>` : "";
  return `<div class="rs-item">
    <div class="rs-head">
      <span class="rs-status rs-${rsEsc(st)}">${rsEsc(st)}</span>
      <span class="rs-q">${rsEsc(r.question || r.id || r.file)}</span>
      <span class="rs-date">${rsEsc(r.date || "")}</span>
    </div>
    ${r.recommendation ? `<div class="rs-rec">${rsEsc(r.recommendation)}</div>` : ""}
    <div class="rs-meta">${tags}${card}<span class="rs-file">${rsEsc(r.file || "")}</span></div>
  </div>`;
}

async function rsLoad(panel){
  const list = panel.querySelector(".rs-list");
  list.innerHTML = `<div class="rs-note">loading…</div>`;
  try{
    const r = await fetch("/api/darkhelix/research");
    const j = await r.json();
    const recs = j.records || [];
    panel.querySelector(".rs-count").textContent = recs.length + (recs.length === 1 ? " record" : " records");
    if(j.error){ list.innerHTML = `<div class="rs-note err">${rsEsc(j.error)}</div>`; return; }
    if(!recs.length){
      list.innerHTML = `<div class="rs-note">No research records yet. Capture one from a done research/analysis card with "⎘ Research" on the board.</div>`;
      return;
    }
    list.innerHTML = recs.map(rsRow).join("");
  }catch(err){ list.innerHTML = `<div class="rs-note err">${rsEsc(err.message)}</div>`; }
}

function openResearch(){
  openWorkTabTurning("research", "main", "RESEARCH", (panel) => {
    panel.classList.add("rs-pane");
    panel.innerHTML = `
      <div class="rs-bar">
        <span class="rs-bar-title">RESEARCH</span>
        <span class="rs-bar-sub">docs/research/ — findings captured from research cards, machine-readable and queryable when planning a feature or upgrade</span>
        <span class="rs-count"></span>
        <span class="rs-spacer"></span>
        <button class="btn rs-reload" title="reload">⟲</button>
      </div>
      <div class="rs-list"></div>`;
    panel.querySelector(".rs-reload").onclick = () => rsLoad(panel);
    panel.querySelector(".rs-list").addEventListener("click", (e) => {
      const c = e.target.closest(".rs-card");
      if(c){ e.preventDefault(); if(typeof openTaskLog === "function") openTaskLog(c.dataset.card); }
    });
    rsLoad(panel);
  });
}

document.querySelectorAll('[data-action="research"]').forEach(b => b.addEventListener("click", openResearch));
