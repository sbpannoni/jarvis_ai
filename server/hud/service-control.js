"use strict";
/* ====================== backend service control =====================
   Start/stop/restart the services the HUD depends on: the Hermes gateway
   (API) + dashboard on the hermes LXC -- and, as its own row, snarf's GPU
   seat. The seat is not a service_control entry: it spans every vllm-* and
   llamacpp-* unit, and only model-seat (/api/seat) may change it, or a raw
   systemctl start can land a second model on GPUs another one holds.
   Driven entirely by service_control: in server.yaml — add an entry there
   and a row appears here, no JS change needed.

   Services flagged `critical` confirm before stop/restart, because they
   take down the very brain this HUD talks to. Stopping the gateway in
   particular makes the HUD's own chat and voice go dead until it's
   started again — the row says so rather than letting it surprise you.

   Depends on $/addActivity from app.js and registerPanel from panels.js.
==================================================================== */
const SERVICE_STATE_CLASS = {active:"ok", failed:"err", unreachable:"err"};

function serviceRowHTML(s){
  const cls = SERVICE_STATE_CLASS[s.active] || "warn";
  const dot = s.active === "active" ? "on" : "off";
  return `
    <div class="svc-row" data-id="${s.id}">
      <div class="kv">
        <span><span class="dot ${dot}"></span>${s.label}</span>
        <b class="${cls}">${s.active}</b>
      </div>
      <div class="svc-btns">
        <button class="btn" data-act="start">START</button>
        <button class="btn amber" data-act="restart">RESTART</button>
        <button class="btn danger" data-act="stop">STOP</button>
      </div>
    </div>`;
}

const SEAT_BACKEND_NAME = {vllm: "vLLM", llamacpp: "llama.cpp"};
let seatBusy = false;

function seatRowHTML(j){
  const st = j.status || {};
  const models = j.models || [];
  const cur = st.model;
  const label = cur ? `${cur} · ${SEAT_BACKEND_NAME[st.backend] || st.backend || "?"}` : (st.ok ? "empty" : "unreachable");
  const cls = cur ? (st.ready === false ? "warn" : "ok") : (st.ok ? "" : "err");
  const groups = {};
  models.forEach(m => { (groups[m.backend || "other"] ||= []).push(m); });
  const opts = Object.keys(groups).map(b => `<optgroup label="${SEAT_BACKEND_NAME[b] || b}">`
    + groups[b].map(m => `<option value="${m.model}"${m.model === cur ? " selected" : ""}>${m.model}</option>`).join("")
    + `</optgroup>`).join("");
  return `
    <div class="svc-row seat-row" data-id="gpu-seat">
      <div class="kv">
        <span><span class="dot ${cur ? "on" : "off"}"></span>GPU seat · snarf</span>
        <b class="${cls}" title="${label}">${label}</b>
      </div>
      <div class="svc-btns seat-btns">
        <select class="seat-select" ${seatBusy ? "disabled" : ""}>${opts}</select>
        <button class="btn" data-seat="switch" ${seatBusy ? "disabled" : ""}
          title="Load the selected model through model-seat: drains in-flight requests, stops whatever holds the GPUs, waits until ready">${seatBusy ? "…" : "LOAD"}</button>
        <button class="btn danger" data-seat="stop" ${seatBusy || !cur ? "disabled" : ""}>STOP</button>
      </div>
    </div>`;
}

async function seatAction(action, model){
  if(action === "stop" && !confirm("Empty the GPU seat? Any in-flight request is drained first; the next Hermes or coder-engine request reloads a model on demand.")) return;
  if(action === "switch" && !confirm(`Load ${model} into the GPU seat? Whatever is loaded now is drained and stopped. A large llama.cpp model can take several minutes.`)) return;
  seatBusy = true; refreshServices();
  addActivity(`gpu seat: ${action}${model ? " " + model : ""}…`);
  try{
    const r = await fetch("/api/seat", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(model ? {action, model} : {action})});
    const j = await r.json();
    addActivity(`gpu seat ${action}: ${j.ok ? "ok" : (j.error || "failed")}`);
  }catch(err){ addActivity(`gpu seat ${action} error: ${err.message}`); }
  seatBusy = false; refreshServices();
}

async function refreshServices(){
  const box = $("servicesList");
  if(!box) return;
  let seatHTML = "";
  try{
    const sr = await fetch("/api/seat");
    seatHTML = seatRowHTML(await sr.json());
  }catch{ seatHTML = `<div class="svc-row"><div class="kv"><span>GPU seat</span><b class="err">unavailable</b></div></div>`; }
  try{
    const r = await fetch("/api/services");
    const j = await r.json();
    const list = j.services || [];
    box.innerHTML = seatHTML + list.map(serviceRowHTML).join("");
    const seatRow = box.querySelector(".seat-row");
    if(seatRow){
      const sel = seatRow.querySelector(".seat-select");
      seatRow.querySelector('[data-seat="switch"]').onclick = () => sel && seatAction("switch", sel.value);
      seatRow.querySelector('[data-seat="stop"]').onclick = () => seatAction("stop");
    }
    list.forEach(s=>{
      const row = box.querySelector(`.svc-row[data-id="${s.id}"]`);
      row.querySelectorAll("button[data-act]").forEach(btn=>{
        btn.onclick = () => serviceAction(s, btn.dataset.act);
      });
    });
  }catch{
    box.innerHTML = "<div class='kv'><span>unavailable</span></div>";
  }
}

async function serviceAction(svc, action){
  if(svc.critical && action !== "start"){
    const extra = svc.id === "hermes-gateway"
      ? " This HUD's own chat and voice will stop working until it is started again."
      : "";
    if(!confirm(`${action.toUpperCase()} ${svc.label}?${extra}`)) return;
  }
  addActivity(`${svc.id}: ${action}…`);
  try{
    const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/action`,{
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({action}),
    });
    const j = await r.json();
    addActivity(`${svc.id} ${action}: ${j.ok ? "ok" : (j.error || "failed")}`);
  }catch(err){
    addActivity(`${svc.id} ${action} error: ${err.message}`);
  }
  // systemd returns as soon as it has spawned the unit; the process needs
  // longer before it is actually serving, so poll rather than trusting the
  // response.
  setTimeout(refreshServices, 1500);
  setTimeout(refreshServices, 6000);
}

registerPanel({id:"services", refresh:refreshServices, intervalMs:20000});
