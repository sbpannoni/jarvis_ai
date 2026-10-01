/* ================================ POOL ===================================
   Reference-pool reproducibility, from database/MANIFEST.yaml via
   GET /api/darkhelix/pool-check. Shows each pool item's kind + how it's rebuilt
   + size, and flags drift: UNLISTED (on disk, no manifest entry = unreproducible),
   MISSING (in manifest, absent on disk), and `manual` items with no source yet.
   The data analog of the code trust gates. Depends on openWorkTabTurning. */
function poolEsc(s){ return (s || "").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])); }
function poolSize(b){ b = +b; if(!b || isNaN(b)) return ""; const u = ["B","KB","MB","GB","TB"]; let i = 0; while(b >= 1024 && i < 4){ b /= 1024; i++; } return b.toFixed(b < 10 && i > 0 ? 1 : 0) + u[i]; }

function poolRow(it){
  const kind = it.kind || "manual";
  const recipe = it.recipe || (kind === "manual" ? "⚠ no source — fill in MANIFEST.yaml" : "");
  return `<div class="pool-item">
    <span class="pool-kind pool-${poolEsc(kind)}">${poolEsc(kind)}</span>
    <span class="pool-path">${poolEsc(it.path || "")}</span>
    <span class="pool-recipe" title="${poolEsc(recipe)}">${poolEsc(recipe)}</span>
    <span class="pool-size">${poolSize(it.size_bytes)}</span>
  </div>`;
}

async function poolLoad(panel){
  const list = panel.querySelector(".pool-list");
  list.innerHTML = `<div class="pool-note">checking the pool against the manifest…</div>`;
  try{
    const r = await fetch("/api/darkhelix/pool-check");
    const j = await r.json();
    if(!j.ok){ list.innerHTML = `<div class="pool-note err">${poolEsc(j.error || "failed")}</div>`; return; }
    const items = j.items || [], unlisted = j.unlisted || [], missing = j.missing || [], manual = j.manual || [];
    panel.querySelector(".pool-count").textContent = j.summary || (items.length + " items");
    let warn = "";
    if(unlisted.length) warn += `<div class="pool-warn err">⚠ ${unlisted.length} on disk but NOT in the manifest — unreproducible. Run scripts/gen_database_manifest.py and commit:<br>${unlisted.map(poolEsc).join("<br>")}</div>`;
    if(missing.length) warn += `<div class="pool-warn err">✖ ${missing.length} in the manifest but missing on disk:<br>${missing.map(poolEsc).join("<br>")}</div>`;
    if(manual.length) warn += `<div class="pool-warn amber">● ${manual.length} need a source filled in (kind: manual): ${manual.map(poolEsc).join(", ")}</div>`;
    if(!warn) warn = `<div class="pool-warn ok">✓ every pool item has a recipe and is present</div>`;
    list.innerHTML = warn + items.map(poolRow).join("");
  }catch(err){ list.innerHTML = `<div class="pool-note err">${poolEsc(err.message)}</div>`; }
}

function openPool(){
  openWorkTabTurning("pool", "main", "POOL", (panel) => {
    panel.classList.add("pool-pane");
    panel.innerHTML = `
      <div class="pool-bar">
        <span class="pool-bar-title">POOL</span>
        <span class="pool-bar-sub">database/MANIFEST.yaml — how each reference DB is rebuilt, and what's unreproducible (git holds the recipe, not the ~640 GB pool)</span>
        <span class="pool-count"></span>
        <span class="pool-spacer"></span>
        <button class="btn pool-reload" title="re-check">⟲</button>
      </div>
      <div class="pool-list"></div>`;
    panel.querySelector(".pool-reload").onclick = () => poolLoad(panel);
    poolLoad(panel);
  });
}

document.querySelectorAll('[data-action="pool"]').forEach(b => b.addEventListener("click", openPool));
