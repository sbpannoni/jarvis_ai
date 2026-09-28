"use strict";
/* ============================ PENDING LEARNING ============================
   What Hermes' kanban workers tried to learn but could not save on their own.
   Profiles with write_approval=true stage a worker's memory/skill writes (and
   its background self-review's) for a human; workers run unattended, so the
   staged lessons used to sit unseen. This pane shows each one in full and
   applies approve/reject through /root/.hermes/scripts/pending-learning on
   CT111 -- the same tool the daily 05:00 Claude audit uses -- so every
   decision, human or Claude, lands in one log with who and why.

   A reason is required: it is the only record of why a lesson was kept or
   thrown away, and the next audit reads it.
============================================================================ */

function plEsc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function plBody(i){
  const p = i.payload || {};
  if(i.subsystem === "memory"){
    const ops = p.operations || (p.content ? [p] : []);
    return ops.map(o => `<div class="pl-op"><span class="pl-op-act">${plEsc(o.action)}</span> ${plEsc(o.content || o.old_text || "")}</div>`).join("")
      || `<pre class="pl-pre">${plEsc(JSON.stringify(p, null, 1))}</pre>`;
  }
  return `<div class="pl-op"><span class="pl-op-act">${plEsc(p.action || "skill")}</span> <b>${plEsc(p.name || "")}</b></div>
    <pre class="pl-pre">${plEsc((p.content || "").slice(0, 6000))}</pre>`;
}

function plItem(i){
  return `<div class="pl-item" data-profile="${plEsc(i.profile)}" data-sub="${plEsc(i.subsystem)}" data-id="${plEsc(i.id)}">
    <div class="pl-head"><span class="pl-prof">${plEsc(i.profile)}</span>
      <span class="pl-sub">${plEsc(i.subsystem)}</span><span class="pl-when">${plEsc(i.created)}</span>
      <span class="pl-origin">${plEsc(i.origin || "")}</span></div>
    <div class="pl-summary">${plEsc(i.summary)}</div>
    ${plBody(i)}
    <div class="pl-actions">
      <input class="pl-reason" placeholder="reason (required) — why keep or discard this lesson">
      <button class="btn pl-act" data-decision="approve">Approve</button>
      <button class="btn danger pl-act" data-decision="reject">Reject</button>
      <span class="pl-status"></span>
    </div></div>`;
}

async function plLoad(panel){
  const list = panel.querySelector(".pl-list"), log = panel.querySelector(".pl-log");
  list.innerHTML = `<div class="pl-note">loading…</div>`;
  try{
    const r = await fetch("/api/learning/pending"); const j = await r.json();
    if(j.error){ list.innerHTML = `<div class="pl-note err">${plEsc(j.error)}</div>`; return; }
    const items = j.pending || [];
    panel.querySelector(".pl-count").textContent = `${items.length} pending`;
    list.innerHTML = items.length ? items.map(plItem).join("")
      : `<div class="pl-note">Nothing pending — every staged lesson has been decided.</div>`;
    log.innerHTML = (j.decisions || []).slice(0, 15).map(d =>
      `<div class="pl-dec"><span class="pl-when">${plEsc(d.ts)}</span> <b>${plEsc(d.by)}</b>
        <span class="${d.decision === "reject" ? "err" : "ok"}">${plEsc(d.decision)}${d.ok === false ? " (FAILED)" : ""}</span>
        ${plEsc(d.profile)}/${plEsc(d.subsystem)} ${plEsc(d.id)} — ${plEsc(d.reason)}</div>`).join("")
      || `<div class="pl-note">No decisions yet.</div>`;
    const rep = panel.querySelector(".pl-report");
    rep.textContent = (j.audit_report || "").trim() || "(no Claude audit has run yet — it runs daily at 05:00)";
  }catch(err){ list.innerHTML = `<div class="pl-note err">${plEsc(err.message)}</div>`; }
}

async function plDecide(panel, item, decision){
  const reason = item.querySelector(".pl-reason").value.trim();
  const st = item.querySelector(".pl-status");
  if(!reason){ st.innerHTML = `<span class="err">give a reason first</span>`; return; }
  st.textContent = "saving…";
  try{
    const r = await fetch("/api/learning/decide", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({profile: item.dataset.profile, subsystem: item.dataset.sub, id: item.dataset.id, decision, reason})});
    const j = await r.json();
    st.innerHTML = j.ok ? `<span class="ok">${decision}d</span>` : `<span class="err">${plEsc(j.error || j.output || "failed")}</span>`;
    if(j.ok) setTimeout(() => plLoad(panel), 800);
  }catch(err){ st.innerHTML = `<span class="err">${plEsc(err.message)}</span>`; }
}

function openPendingLearning(){
  openWorkTabTurning("learning", "main", "PENDING LEARNING", (panel) => {
    panel.classList.add("pl-pane");
    panel.innerHTML = `
      <div class="pl-bar"><span class="pl-bar-title">PENDING LEARNING</span>
        <span class="pl-bar-sub">lessons Hermes workers tried to save — decide what they keep</span>
        <span class="pl-count"></span><span class="pl-spacer"></span>
        <button class="btn pl-reload">⟲</button></div>
      <div class="pl-list"></div>
      <details class="pl-section"><summary>Latest Claude audit (daily 05:00)</summary><pre class="pl-report"></pre></details>
      <details class="pl-section" open><summary>Recent decisions</summary><div class="pl-log"></div></details>`;
    panel.querySelector(".pl-reload").onclick = () => plLoad(panel);
    panel.querySelector(".pl-list").addEventListener("click", (e) => {
      const b = e.target.closest(".pl-act"); if(!b) return;
      plDecide(panel, b.closest(".pl-item"), b.dataset.decision);
    });
    plLoad(panel);
  });
}

/* Badge on the kanban board header: how many lessons are waiting. Refreshed on
   the board's own poll (kanban.js calls plRefreshBadge from refreshKanbanPause). */
async function plRefreshBadge(panel){
  const b = panel && panel.querySelector(".kb-learning");
  if(!b) return;
  try{
    const r = await fetch("/api/learning/pending"); const j = await r.json();
    const n = (j.pending || []).length;
    b.textContent = `🧠 ${n} pending learning`;
    b.classList.toggle("has", n > 0);
  }catch{ /* never disturb the board */ }
}
