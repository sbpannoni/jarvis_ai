"use strict";
/* ====================== GPU PANEL (snarf) ===========================
   The two Quadro RTX 6000s are the scarcest thing in the fleet: one model
   sits in the seat at a time, and when they are busy nothing else in the
   rack can think. That makes them the sidebar's most important readout,
   so they are rendered as vertical bars near the top rather than as another
   key/value row buried in MACHINES.

   Data: /api/rack_health, which queries the nvidia_gpu_exporter on
   snarf:9835 through Prometheus on CT110. Every GPU query returns TWO
   series, one per card.

   ORDERING TRAP: the exporter returns series in arbitrary order, and uuid
   04185dbf is physically GPU *1* while 23afce94 is GPU *0*. Rendering by
   array position silently mislabels the cards. Always join on
   snarf_gpu_index.
==================================================================== */

function gpuByUuid(series) {
  const out = {};
  (series || []).forEach(r => {
    const u = r && r.labels && r.labels.uuid;
    if (u) out[u] = r.value;
  });
  return out;
}

function gpuTempClass(c) {
  if (c == null) return "";
  if (c >= 80) return "gpu-t-hot";
  if (c >= 65) return "gpu-t-warm";
  return "gpu-t-ok";
}

function gpuFmtBytes(b) {
  if (!b && b !== 0) return "—";
  return (b / 1073741824).toFixed(1) + "G";
}

function renderGpuPanel(rh) {
  const host = document.getElementById("gpuBars");
  if (!host) return;

  const idx = rh && rh.snarf_gpu_index;
  if (!Array.isArray(idx) || !idx.length) {
    host.innerHTML = '<div class="gpu-offline">— GPU telemetry unavailable —</div>';
    return;
  }

  const temp  = gpuByUuid(rh.snarf_gpu_temp_c);
  const util  = gpuByUuid(rh.snarf_gpu_util_ratio);
  const used  = gpuByUuid(rh.snarf_gpu_mem_used);
  const total = gpuByUuid(rh.snarf_gpu_mem_total);
  const power = gpuByUuid(rh.snarf_gpu_power_w);

  // Sort by PHYSICAL index, not by the order Prometheus happened to return.
  const cards = idx
    .map(r => ({ uuid: r.labels.uuid, i: Number(r.value) }))
    .sort((a, b) => a.i - b.i);

  host.innerHTML = cards.map(({ uuid, i }) => {
    const u = util[uuid];
    const uPct = u == null ? 0 : Math.max(0, Math.min(100, u * 100));
    const mu = used[uuid], mt = total[uuid];
    const mPct = (mu != null && mt) ? Math.max(0, Math.min(100, (mu / mt) * 100)) : 0;
    const t = temp[uuid], w = power[uuid];
    return `
      <div class="gpu-card">
        <div class="gpu-bars">
          <div class="gpu-bar" title="utilization ${uPct.toFixed(0)}%"><i style="height:${uPct}%"></i></div>
          <div class="gpu-bar vram" title="VRAM ${gpuFmtBytes(mu)} / ${gpuFmtBytes(mt)}"><i style="height:${mPct}%"></i></div>
        </div>
        <div class="gpu-caps"><span>UTL</span><span>VRM</span></div>
        <div class="gpu-name">GPU${i}</div>
        <div class="gpu-stats">
          <b>${uPct.toFixed(0)}%</b> · <b>${mPct.toFixed(0)}%</b><br>
          <span class="${gpuTempClass(t)}">${t == null ? "—" : t + "°C"}</span>
          · ${w == null ? "—" : w.toFixed(0) + "W"}
        </div>
      </div>`;
  }).join("");
}

/* ---- shared CPU grid ---------------------------------------------------
   snarf's CPU is shared by everything that isn't on the GPUs (llama.cpp's
   CPU-offloaded experts, DARKHELIX pipelines, builds), so it sits under the
   GPU bars. One cell per PHYSICAL core (64), split top/bottom into its two
   SMT threads (N and N+64 on this box, per thread_siblings_list), shaded by
   each thread's 1m busy fraction. A core with both halves lit is saturated;
   one half lit is a single thread on it.

   Cores are SORTED by activity and fill from the bottom-left, so the grid
   reads like the GPU bars: the lit area rises with load. Within a core the
   busier thread takes the bottom half for the same reason. Position is
   therefore not core number -- hover a cell for which core it is. Data:
   snarf_cpu_busy in
   /api/rack_health (128 series with a `cpu` label). */
function cpuCellColor(b) {
  if (b == null) return "transparent";
  const pct = Math.round(Math.max(0, Math.min(1, b)) * 100);
  if (pct >= 85) return "var(--amber)";
  return `color-mix(in srgb, var(--cyan) ${pct < 3 ? 0 : 18 + pct * 0.82}%, transparent)`;
}

function renderCpuGrid(rh) {
  const host = document.getElementById("cpuGrid");
  if (!host) return;
  const series = rh && rh.snarf_cpu_busy;
  if (!Array.isArray(series) || !series.length) { host.innerHTML = ""; return; }
  const busy = {};
  series.forEach(r => { const c = r && r.labels && r.labels.cpu; if (c != null) busy[Number(c)] = r.value; });
  const n = Object.keys(busy).length;
  const cores = Math.ceil(n / 2);
  const vals = Object.values(busy);
  const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const active = vals.filter(v => v >= 0.5).length;
  const load = ((rh.snarf_cpu_load1 || [])[0] || {}).value;
  const pct = b => b == null ? "—" : Math.round(b * 100) + "%";
  const list = [];
  for (let c = 0; c < cores; c++) {
    const a = busy[c], b = busy[c + cores];
    list.push({c, a, b, sum: (a || 0) + (b || 0)});
  }
  list.sort((x, y) => y.sum - x.sum || x.c - y.c);
  const COLS = 16;
  const rows = [];
  for (let i = 0; i < list.length; i += COLS) rows.push(list.slice(i, i + COLS));
  // Busiest row last in the DOM = bottom of the grid.
  const cells = rows.reverse().map(row => row.map(({c, a, b}) => {
    const [top, bottom] = (a || 0) >= (b || 0) ? [b, a] : [a, b];
    return `<div class="cpu-core" title="core ${c} · cpu${c} ${pct(a)} · cpu${c + cores} ${pct(b)}">`
      + `<i style="background:${cpuCellColor(top)}"></i><i style="background:${cpuCellColor(bottom)}"></i></div>`;
  }).join("")).join("");
  host.innerHTML = `
    <div class="cpu-grid-head"><span>CPU · ${cores}C/${n}T</span>
      <span><b>${Math.round(avg * 100)}%</b> · ${active} busy${load == null ? "" : ` · load ${load.toFixed(1)}`}</span></div>
    <div class="cpu-grid">${cells}</div>`;
}

async function pollGpuPanel() {
  try {
    const r = await fetch("/api/rack_health", { credentials: "same-origin" });
    if (r.ok) { const rh = await r.json(); renderGpuPanel(rh); renderCpuGrid(rh); }
  } catch { /* transient; keep the last good render rather than blanking */ }
}

addEventListener("DOMContentLoaded", () => {
  pollGpuPanel();
  setInterval(pollGpuPanel, 10000);   // matches the endpoint's own 10s cache
});
