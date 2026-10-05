"use strict";
/* ============================== KANBAN =============================
   The view for managing agentic work.

   The HUD's own chat session is not where work happens — each kanban card
   runs in its own Hermes session and workspace. This shows the board, and
   lets you open any task's live run log, which is the actual "what is the
   agent doing right now" view.

   LANES, not a list. /api/kanban returns `columns` already grouped and
   ordered by the board's own status model (triage -> todo -> scheduled ->
   ready -> running -> blocked -> review -> done). A single column of
   full-width cards spent 1200px of width on three lines of text and still
   needed 1400px of scroll for 13 cards; as lanes the whole board fits on
   screen. Empty lanes collapse to a rail so the occupied ones get the width
   — with five of eight statuses empty, that is the difference between
   fitting and not.

   Cards are reconciled by id rather than re-rendered wholesale: replacing
   .innerHTML on every 15s poll destroyed scroll position, which made any
   card below the fold unreadable if you read slowly.

   Depends on $/openWorkTab from app.js.
=================================================================== */
const KANBAN_STATUS_CLASS = {
  running:"ok", done:"ok", ready:"warn", todo:"", blocked:"err",
  review:"warn", scheduled:"", triage:"warn", archived:"",
};

/* Task-log pane is blank until a card is actually dispatched — there is no
   run log file for a card still sitting in --triage. That reads as "stuck"
   with nothing else on screen, so the status header spells out what's
   actually happening at each stage (mirrors kanban_create's own module note
   in server.py: triage -> the specifier decomposes it -> dispatcher picks
   it up -> only then does a real log start). */
const KANBAN_STATUS_MSG = {
  triage: "queued for triage — waiting on Hermes's specifier to decompose it",
  todo: "specified — waiting for the dispatcher to pick it up",
  ready: "ready — waiting for the dispatcher to pick it up",
  scheduled: "scheduled — waiting for its window",
  blocked: "blocked — needs attention",
  running: "running — live log below",
  // (a running card that is actually wedged is recoverable: see Reclaim)
  review: "awaiting review",
  done: "done",
  archived: "archived",
};

/* Lane order for the ssh fallback, which returns a flat list and no columns.
   Matches the plugin API's own ordering so the board looks the same
   whichever transport served it. */
const KANBAN_LANE_ORDER = ["triage","todo","scheduled","ready","running","blocked","review","done","archived"];

/* Card buttons, as data. The click handler used to branch on a single
   "is it unblock?" boolean, which is why adding a third action needed this
   table rather than a third nested ternary. */
const KB_CARD_ACTIONS = {
  unblock: {endpoint:"/api/kanban/unblock", verb:"Unblock"},
  archive: {endpoint:"/api/kanban/archive", verb:"Archive"},
  reclaim: {endpoint:"/api/kanban/reclaim", verb:"Reclaim"},
  // The triage review gate (auto_decompose is off, so a sweep/review card waits
  // in triage until a human acts). Approve sends it to ready in place -- no
  // title/body rewrite, unlike the decomposer. Dismiss is just an archive with
  // its own label so the button reads "Dismissing…" not "Archiveing…".
  approve: {endpoint:"/api/kanban/approve", verb:"Approve"},
  dismiss: {endpoint:"/api/kanban/archive", verb:"Dismiss"},
  // Done card that identified a problem but wrote no code -> file a [Fix] card
  // that dispatches a worker to actually apply + commit the fix.
  codefix: {endpoint:"/api/kanban/code-fix", verb:"Code fix"},
};

/* commits-ahead per done card (from /api/kanban/diffstats): 0 = finished but
   changed nothing, >0 = wrote code, null/absent = no branch or not yet known.
   Refreshed alongside the board; the server caches the git calls for a tick. */
let kbDiffstats = {};
/* staged-file count per done card (same endpoint): >0 = the card left reference
   files in its pool-staging dir that have NOT reached the shared pool (the
   engine sees it read-only) -- i.e. there is data to Promote. */
let kbStaged = {};
/* PR state per done card's hermes/<id> branch (GitHub truth): {state,number,url}.
   The durable "did it merge" signal -- a merged PR's local branch is pinned by
   its worktree and never clears the commit count, so the Merge button is driven
   by this, not by diffstats alone. kbLanding = ids whose land is in flight. */
let kbPrs = {};
let kbLanding = [];
/* task_ids whose PR the finalize reconciler is actively driving to merge. An
   OPEN PR that is in neither kbLanding nor kbFinalizing is STALLED, not merging
   -- so the stage machine doesn't label an abandoned PR as in-progress. */
let kbFinalizing = [];
/* parent->child edges (from /api/kanban/links): group a decomposition's cards
   into one collapsible family in the done lane. */
let kbEdges = [];
/* latest integration-review verdict per card ({id: "approve"|"request_changes"|
   "escalate"}) and the set of ids with a review in flight -- the live review
   state the board shows so a running/finished review is visible, not silent. */
let kbReviews = {};
let kbReviewing = [];
/* card_ids that have an in-flight [Fix] child (a fix was dispatched for their
   review changes and hasn't finished). Drives the FIXING stage so a flagged
   card reads "↻ fixing…" after you click Fix, instead of reverting to the Fix
   button on the next re-render (the verdict stays request_changes until the fix
   completes and re-reviews). Computed from tasks + kbEdges each refresh. */
let kbFixInFlight = {};
let kbFixedBy = {};        // reviewed card id -> its finished [Fix] child
let kbIntegratedBy = {};   // source card id -> the live [Integrate] card that wove it
/* Auto-assessment (client-side): a done code card is Verified (static, instant,
   no model) and Reviewed (agentic) automatically, so the human never clicks
   through a gate pipeline -- they only decide Merge / Fix. kbVerified holds the
   static verdict ("pass"/"fail"); review verdicts live in kbReviews (server).
   Auto-review is serialized to one in-flight and skipped while a worker holds
   the GPU seat (reviewer == engine model, so no seat swap, but we don't want to
   share throughput with a live run). */
let kbVerified = {};
let kbVerifyInflight = [];
let kbAutoReviewInflight = [];
let kbAutoAssessOn = kbPrefLoad("lg-kb-autoassess", true);
/* AGENT ACTIVITY feed: the left panel was dead (it only logged HUD chat
   tool-use, which goes unused). These track the last poll so kbTrackActivity
   can emit real agent work -- dispatches, reviews, merges -- into #activity. */
let kbActSeeded = false;
let kbPrevRunning = {};
let kbPrevReviewing = {};
let kbPrevPrState = {};
/* card_ids that already have a docs/research record (findings submitted), so a
   done analysis card shows "✓ submitted" instead of re-arming the Submit button
   -- re-submitting is now idempotent server-side, but the UI shouldn't invite it. */
let kbCaptured = {};
const KB_FAM_KEY = "lg-kb-fam-expanded";  // {leadId: true} -- which families are open
const KB_ARCHIVED_KEY = "lg-kb-show-archived";  // show the archived lane

const KB_COLLAPSED_KEY = "lg-kb-collapsed";
const KB_ASSIGNEE_KEY  = "lg-kb-assignee";

function kbPrefLoad(key, fallback){
  try{ const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch{ return fallback; }
}
function kbPrefSave(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }catch{ /* storage disabled */ }
}

function kanbanEsc(s){
  return (s||"").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
}

function kanbanAge(task){
  const t = task.completed_at || task.started_at || task.created_at;
  if(!t) return "";
  // Hermes returns Unix SECONDS. Feeding those to new Date() treats them as
  // milliseconds and reports every card as ~56 years old.
  const epochMs = typeof t === "number" ? t*1000 : new Date(t).getTime();
  const ms = Date.now() - epochMs;
  if(isNaN(ms)) return "";
  const m = Math.floor(ms/60000);
  if(m < 1) return "just now";
  if(m < 60) return m+"m";
  const h = Math.floor(m/60);
  return h < 24 ? h+"h" : Math.floor(h/24)+"d";
}

/* How long a card has actually been running, in minutes. Distinct from
   kanbanAge, which reports whichever timestamp is newest — for a running
   card that is started_at, but the two diverge for every other status and
   only the running clock says anything about being stuck. */
function kbRunningMinutes(task){
  if(task.status !== "running" || !task.started_at) return 0;
  const t = task.started_at;
  const epochMs = typeof t === "number" ? t*1000 : new Date(t).getTime();
  if(isNaN(epochMs)) return 0;
  return Math.floor((Date.now() - epochMs)/60000);
}

/* Past this, a running card is presumed wedged rather than working. Cards
   carry a max-runtime the dispatcher enforces on its own tick; a card that
   is well past any plausible cap is exactly the one nothing else will move.
   It changes presentation only — Reclaim is offered on every running card. */
const KB_STUCK_MINUTES = 30;

async function kanbanCardAction(panel, endpoint, verb, id, btn){
  btn.disabled = true;
  btn.textContent = verb + "ing…";
  try{
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: id}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = verb + " failed — retry"; return; }
    refreshKanbanPanel(panel);
  }catch(err){ btn.disabled = false; btn.textContent = verb + " failed — retry"; }
}

/* ------------------------------ lanes -------------------------------- */

/* Group a flat task list into the same shape /api/kanban's `columns` has, so
   the renderer never has to care which transport answered. */
function kanbanColumnsFromTasks(tasks){
  const by = new Map();
  tasks.forEach(t => {
    const k = t.status || "todo";
    if(!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  });
  const known = KANBAN_LANE_ORDER.filter(n => by.has(n)).map(n => ({name:n, tasks:by.get(n)}));
  // A status this list doesn't know about still gets a lane rather than
  // vanishing off the board.
  const extra = [...by.keys()].filter(n => !KANBAN_LANE_ORDER.includes(n))
                              .map(n => ({name:n, tasks:by.get(n)}));
  return known.concat(extra);
}

/* Everything a card displays. If this string is unchanged the card's DOM is
   left completely alone — that is what keeps scroll and hover stable across
   a poll. */
/* ---- review chain + model seat ----------------------------------------
   Review-chain cards are only recognisable by title prefix ("[Review] <file>",
   "[Fix] <file> (attempt N)" -- server.py's review-file / process-fix-card),
   which read as noise in a lane. Show them as a chip and strip the prefix.

   Runs don't record which model served them, so the only honest model to
   show is the one in snarf's GPU seat right now -- and only on RUNNING cards,
   where "the seat's model" and "this card's model" are the same thing. */
const KB_SEAT_TTL_MS = 30000;
let kbSeat = {label: null, at: 0, inflight: null};

async function kbRefreshSeat(){
  if(kbSeat.inflight || Date.now() - kbSeat.at < KB_SEAT_TTL_MS) return kbSeat.inflight;
  kbSeat.inflight = (async () => {
    try{
      const r = await fetch("/api/seat");
      const j = await r.json();
      kbSeat.label = (typeof lgSeat === "function") ? lgSeat(j.seat).label : (j.seat || {}).occupant;
    }catch{ kbSeat.label = null; }
    kbSeat.at = Date.now();
    kbSeat.inflight = null;
  })();
  return kbSeat.inflight;
}

function kbChainKind(t){
  const title = t.title || "";
  if(title.startsWith("[Review] ")) return {kind: "review", rest: title.slice(9)};
  if(title.startsWith("[Applied Fix] ")) return {kind: "applied", rest: title.slice(14)};
  if(title.startsWith("[Fix] ")){
    const rest = title.slice(6);
    const m = rest.match(/^(.*) \(attempt (\d+)\)$/);
    return {kind: "fix", rest: m ? m[1] : rest, attempt: m ? +m[2] : 1};
  }
  return null;
}

function kbChainChip(c){
  if(!c) return "";
  if(c.kind === "applied")
    return `<span class="kb-chip kb-chain applied" title="The reviewer already applied this fix on its own branch: it passed the engine test gate and closure review. Not merged. Read the diff, then land the branch or discard it (commands are on the card).">APPLIED</span>`;
  return c.kind === "review"
    ? `<span class="kb-chip kb-chain review" title="Review-chain review card: findings only, filed to triage. Never edits code">REVIEW</span>`
    : `<span class="kb-chip kb-chain fix" title="Review-chain fix card: dispatchable, the editor works it unsupervised once it is ready. Process it after it finishes to run the gates + closure review">FIX${c.attempt > 1 ? " #" + c.attempt : ""}</span>`;
}

function kbCardSignature(t){
  const lc = t.link_counts || {};
  const pr = t.progress || {};
  return [t.status, t.title, t.assignee, t.comment_count, t.completed_at,
          t.started_at, t.block_kind, t.last_failure_error,
          lc.parents, lc.children, pr.done, pr.total,
          t.status === "running" ? kbSeat.label : "",
          // Re-render a done card when its commit count arrives/changes, so the
          // "no diff" badge and Code-fix button appear without a full rebuild.
          t.status === "done" ? kbDiffstats[t.id] : "",
          // Same for staged-file count: drives the Promote-refs button.
          t.status === "done" ? kbStaged[t.id] : "",
          // PR/landing state drives the Merge button vs merged/merging chips.
          t.status === "done" ? JSON.stringify(kbPrs[t.id] || null) : "",
          t.status === "done" ? (kbLanding.indexOf(t.id) !== -1) : "",
          t.status === "done" ? (kbFinalizing.indexOf(t.id) !== -1) : "",
          t.status === "done" ? (!!kbFixInFlight[t.id]) : "",
          t.status === "done" ? (kbFixedBy[t.id] || "") : "",
          t.status === "done" ? (kbIntegratedBy[t.id] || "") : "",
          // Review state drives the review chip / Fix-issues button.
          t.status === "done" ? (kbReviews[t.id] || "") : "",
          t.status === "done" ? (kbReviewing.indexOf(t.id) !== -1) : "",
          // Static-verify verdict drives the ✓/⚠ tests chip.
          t.status === "done" ? (kbVerified[t.id] || "") : "",
          // Captured flag swaps Submit findings → "✓ submitted".
          t.status === "done" ? (kbCaptured[t.id] ? "C" : "") : ""].join("|");
}

/* ---- dependency state -------------------------------------------------
   A decomposed card's position in the graph was invisible here. The
   decomposer writes plain descriptive titles ("Decide amplicon sourcing
   strategy", "Implement GFF-based sequence extraction") with no ordering
   hint, and the board rendered only title/assignee/age — so a card sitting
   in `todo` BECAUSE it is waiting on an unfinished parent looked exactly
   like one that is merely queued. You had to run `hermes kanban show` per
   card to find the order.

   Hermes holds a child in `todo` while any parent is open and promotes it to
   `ready` once they all close (the same machinery `block --kind dependency`
   relies on). So `todo` + parents > 0 IS "blocked on dependencies" — no
   extra request needed, the board already sends link_counts and progress. */
function kbDepChips(t){
  const lc = t.link_counts || {};
  const parents = lc.parents || 0;
  const pr = t.progress || null;
  const chips = [];
  if(parents){
    // In `todo` the parents are the reason it is not running. Anywhere else
    // they are just provenance, so say it quietly.
    const waiting = t.status === "todo";
    chips.push(`<span class="kb-chip kb-dep${waiting ? " waiting" : ""}"
      title="${waiting
        ? `Waiting on ${parents} unfinished card${parents === 1 ? "" : "s"} — it cannot start until they finish`
        : `Depends on ${parents} earlier card${parents === 1 ? "" : "s"}`}"
      >${waiting ? "⛓" : "↳"} ${parents}</span>`);
  }
  // Child progress is a LIVE signal (how far a decomposition has got). On a
  // done/archived card it's misleading: a child that merged and archived no
  // longer counts as "done" here, so a finished analysis parent whose children
  // all landed reads "0/2" and looks blocked when its only next step is Archive.
  if(pr && pr.total && t.status !== "done" && t.status !== "archived"){
    const done = pr.done === pr.total;
    chips.push(`<span class="kb-chip kb-kids${done ? " ok" : ""}"
      title="${pr.done} of ${pr.total} child card${pr.total === 1 ? "" : "s"} done"
      >${pr.done}/${pr.total}</span>`);
  }
  return chips.join("");
}

/* ---- done-card controls: ONE actionable next step + passive state chips ----
   Done was turning into a second kanban: every card showed up to four
   differently-coloured buttons (Verify / Review / Merge / Integrate), several
   of them no-ops in the card's current state. Now a done card surfaces exactly
   one PRIMARY action (what to do next) plus status chips, and COLOUR means
   STATE, not button identity:
     cyan  = the one action to take    (.kb-primary)
     green = finished / passed         (.kb-st-done)
     amber = in-flight / assessing     (.kb-st-live)
     red   = needs attention           (.kb-st-attn)
   Verify and Review run automatically (kbAutoAssess), so the human decides only
   Merge / Fix / Integrate. Merge stays a deliberate click -- it is the one
   irreversible, master-touching action -- and it stays AVAILABLE even while the
   assessment is still running, so the human is never blocked by the pipeline.
   The chips just say what is known so far. */
/* kbCardStage: the SINGLE source of truth for a done card's lifecycle stage.
   Every signal the done-card UI shows -- the one primary action, the status
   chips, whether it's archivable -- derives from ONE stage computed here, in
   priority order, so no combination of (code/no-code, PR state, review verdict,
   captured, family, children) can emit the contradictory signals that scattered
   conditionals used to. Returns a data descriptor; kbStageHtml renders it.
   opts.family={codeIds,ids} on a family head (enables Integrate + archive-all);
   opts.noMerge on a nested member. */
function kbCardStage(t, opts){
  opts = opts || {};
  const id = t.id;
  const pr = kbPrs[id] || {};
  const rawCommits = kbDiffstats[id];               // null = no branch, 0 = ran but no change
  const commits = rawCommits || 0;
  const review = kbReviews[id];
  const reviewing = kbReviewing.indexOf(id) !== -1;
  const landing = kbLanding.indexOf(id) !== -1;
  const finalizing = kbFinalizing.indexOf(id) !== -1;
  const verify = kbVerified[id];
  const captured = !!kbCaptured[id];
  const chain = kbChainKind(t);
  const children = (t.link_counts || {}).children || 0;
  const fam = opts.family;
  const chip = (cls, text, title) => ({cls, text, title});
  const act = (action, label, title, data) => ({action, label, title, data: data || {}});
  const S = (stage, extra) => Object.assign({stage, primary: null, chips: [], secondary: [], archivable: false}, extra || {});

  if(t.status !== "done") return S("NONE");

  // terminal / in-flight -- status only, nothing to click
  if(pr.state === "MERGED")
    return S("MERGED", {chips: [chip("kb-st-done", "merged #" + pr.number, "Merged to master as #" + pr.number + " — " + (pr.url || ""))], archivable: true});
  // "merging" means ACTIVELY being finalized -- an open PR the reconciler/land
  // is driving, or a land just started. An OPEN PR in NEITHER set is STALLED,
  // not merging (e.g. an old PR with requested changes, or one orphaned before
  // the durable reconciler) -- it falls through to its real stage below.
  if(pr.state === "OPEN" && (landing || finalizing))
    return S("MERGING", {chips: [chip("kb-st-live", "merging #" + pr.number, "PR #" + pr.number + " — being finalized (CI → squash-merge). " + (pr.url || ""))]});
  if(landing)
    return S("LANDING", {chips: [chip("kb-st-live", "landing…", "Landing started — opening the PR…")]});

  // nested family member -- it lands via the lead
  if(opts.noMerge) return S("MEMBER");

  const stalledPr = pr.state === "OPEN"
    ? chip("kb-st-attn", "PR #" + pr.number + " stalled", "A PR is open but nothing is merging it. " + (pr.url || ""))
    : null;

  // review flagged problems -> Fix, BEFORE Integrate/Merge: known-bad work is
  // fixed first, even if a stale PR is still open for it (this is why #8/#9 read
  // "merging" before -- the open PR masked their requested changes).
  if((review === "request_changes" || review === "escalate") && kbFixedBy[id]){
    // The fix already finished; it carries its own review and its own Merge. Offering
    // "Fix issues" here is what forked the work.
    const chips = [chip("kb-st-done", "fixed by " + kbFixedBy[id].slice(2, 8),
      "This card's review asked for changes and " + kbFixedBy[id] + " already made them. That card is reviewed on its own; land or fix it there, not from this stale verdict.")];
    if(stalledPr) chips.push(stalledPr);
    return S("FIXED", {chips});
  }
  if(review === "request_changes" || review === "escalate"){
    // A fix was already dispatched and is still running -> show that, don't keep
    // offering (and re-arming) the Fix button on every re-render.
    if(kbFixInFlight[id])
      return S("FIXING", {chips: [chip("kb-st-live", "↻ fixing…", "A [Fix] card is addressing the requested changes; it re-reviews when it finishes.")].concat(stalledPr ? [stalledPr] : [])});
    const chips = [chip("kb-st-attn", "review: " + (review === "escalate" ? "escalate" : "changes"), "Agentic review asked for changes — open the card for the comment.")];
    if(stalledPr) chips.push(stalledPr);
    return S("NEEDS_FIX", {chips, primary: act("fix-review", "Fix issues", "Dispatch an editor to address the review's requested changes. Files a [Fix] card and runs it.")});
  }

  // a family of loose code branches nothing has woven yet -> Integrate
  if(kbIntegratedBy[id] && !(t.title || "").startsWith("[Integrate]"))
    return S("INTEGRATED", {chips: [chip("kb-st-done", "integrated in " + kbIntegratedBy[id].slice(2, 8),
      "These branches were already woven by " + kbIntegratedBy[id] + ". Review or land that card instead of integrating again.")]});
  if(fam && (fam.codeIds || []).length >= 2 && commits > 0 && !(t.title || "").startsWith("[Integrate]"))
    return S("INTEGRATE", {primary: act("integrate", "Integrate " + fam.codeIds.length,
      "Agentic merge: weave these " + fam.codeIds.length + " code branches into ONE coherent change WITH tests, then land it CI-gated. For loose feature branches no integration card has woven yet.",
      {ids: fam.codeIds.join(","), title: (chain ? chain.rest : t.title)})});

  // review-chain fix card carrying a findings block -> its own closure pipeline
  if(chain && chain.kind === "fix" && t.has_findings)
    return S("PROCESS_FIX", {primary: act("process-fix", "Process",
      "Run the review chain on this finished fix: mechanical gates, then closure review, then accept / retry / escalate.")});

  // code-bearing card, not yet landed -> Merge, annotated with assessment chips
  if(commits > 0){
    const chips = [];
    if(stalledPr) chips.push(stalledPr);   // an open-but-stalled PR; Merge re-drives it
    if(verify === "pass") chips.push(chip("kb-st-done", "tests", "Static pre-merge check passed: brought tests, didn't weaken existing ones."));
    else if(verify === "fail") chips.push(chip("kb-st-attn", "tests", "Static check: missing tests, or an existing test was weakened — read the diff before merging."));
    if(review === "approve") chips.push(chip("kb-st-done", "review", "Agentic review approved this change."));
    else if(reviewing) chips.push(chip("kb-st-live", "assessing…", "Pre-merge review is running automatically — its verdict will appear here."));
    return S("READY_MERGE", {chips, primary: act("land", "Merge",
      "Merge this card's work to master: opens a PR, waits for CI, squash-merges if green (background). Asks once.")});
  }

  // review-chain card with nothing to process -> no action here
  if(chain) return S("CHAIN_DONE");

  // no code: an analysis / findings card
  if(captured)
    return S("SUBMITTED", {chips: [chip("kb-st-done", "✓ submitted", "Findings already filed to docs/research/. Archive when done; re-submitting only updates that record.")], archivable: true});
  // Submit is the primary; a card that RAN but committed nothing (0, not a
  // branch-less analysis card) can instead be turned into a dispatched fix.
  const secondary = (rawCommits === 0 && !children)
    ? [act("codefix", "Code the fix", "This card identified a problem but committed no code. File a [Fix] card that dispatches a worker to write and commit the fix, linked back to this card.")]
    : [];
  return S("NEEDS_SUBMIT", {secondary, primary: act("capture-research", "Submit findings",
    "File this card's findings into docs/research/ (committed to the repo) — the analysis counterpart to Merge. Edit it afterward to sharpen the recommendation/tags.")});
}

/* Render a stage descriptor: chips, then the one primary (cyan), then any
   secondary actions (muted). The only place button/chip HTML is built. */
function kbStageHtml(desc, id){
  const esc = kanbanEsc;
  const data = d => Object.keys(d || {}).map(k => `data-${k}="${esc(String(d[k]))}"`).join(" ");
  const button = (b, cls) =>
    `<button class="btn kb-card-btn ${cls}" data-action="${esc(b.action)}" data-id="${esc(id)}" ${data(b.data)} title="${esc(b.title || "")}">${esc(b.label)}</button>`;
  let h = desc.chips.map(c => `<span class="kb-chip ${c.cls}" title="${esc(c.title || "")}">${esc(c.text)}</span>`).join("");
  if(desc.primary) h += button(desc.primary, "kb-primary");
  (desc.secondary || []).forEach(b => { h += button(b, "kb-secondary"); });
  return h;
}

/* Thin wrapper over the stage machine for the done-card and family-head call
   sites. On a family head (opts.family) it also offers Archive-all once the
   stage says the family is archivable (merged, or a finished analysis family). */
function kbDoneControls(t, opts){
  if(t.status !== "done") return "";
  const desc = kbCardStage(t, opts);
  let h = kbStageHtml(desc, t.id);
  if(opts && opts.family && desc.archivable){
    const ids = opts.family.ids || [];
    h += `<button class="btn kb-card-btn kb-fam-archive" data-action="archive-family" data-ids="${kanbanEsc(ids.join(","))}" title="Archive this family — all ${ids.length} cards move to the archived lane.">Archive family</button>`;
  }
  return h;
}

/* Is this done card the merge target for its family -- i.e. the integrating
   card whose branch subsumes the siblings? Highest commit count wins, then a
   card that already has a PR, then id. Used to put the family's single Merge on
   the right card and to drive Merge-all. */
function kbMergeable(t){
  const pr = kbPrs[t.id];
  if(pr && (pr.state === "MERGED" || pr.state === "OPEN")) return false;
  if(kbLanding.indexOf(t.id) !== -1) return false;
  return (kbDiffstats[t.id] || 0) > 0;
}

function kbCardInner(t, opts){
  const noMerge = !!(opts && opts.noMerge);  // family members merge via the head
  const chain = kbChainKind(t);
  const seat = (t.status === "running" && kbSeat.label)
    ? `<div class="kb-seat" title="Model in snarf's GPU seat right now -- runs don't record their model, so this is only shown while the card is running">● ${kanbanEsc(kbSeat.label)}</div>`
    : "";
  const comments = t.comment_count ? `<span class="kb-chip">${t.comment_count}c</span>` : "";
  // Did this card actually write code? commits ahead on its hermes/<id> branch.
  // Only meaningful for done cards; null = no branch, undefined = not yet known.
  const commits = t.status === "done" ? kbDiffstats[t.id] : undefined;
  const noWork = commits === 0;
  const diffBadge = (t.status === "done" && commits !== undefined && commits !== null)
    ? (noWork
        ? `<span class="kb-chip kb-nodiff" title="Completed without committing any code — its branch is 0 commits ahead of master. A review card does this by design; a card meant to fix something did NOT do the work.">∅ no diff</span>`
        : `<span class="kb-chip kb-diff ok" title="${commits} commit${commits===1?"":"s"} on this card's branch, ahead of master">+${commits}</span>`)
    : "";
  // The lane header already says what the status is, so the card doesn't
  // repeat it — that word was most of the old card's height.
  const note = (t.status === "blocked" && t.last_failure_error)
    ? `<div class="kb-note">${kanbanEsc(String(t.last_failure_error)).slice(0,140)}</div>`
    : "";
  // Every non-terminal lane needs SOME way out of it by hand, or a card that
  // wedges there is unrecoverable from the HUD. `running` had none: when a
  // worker dies mid-run the claim is never released and the card sits in the
  // running lane indefinitely (the board still shows one from five days ago).
  //
  // Reclaim is not a park button. Per hermes_cli/kanban_db.py:reclaim_task it
  // SIGTERM/SIGKILLs the worker, clears the claim, and sets the card to
  // `ready` -- which is DISPATCHABLE, so the gateway starts a fresh run on its
  // next pass and spends another model run. The tooltip says so, because
  // "reclaim" on its own sounds free.
  // triage is the human review gate: nothing drains it automatically here
  // (auto_decompose is off on purpose), so a sweep/review finding waits for a
  // person to read it and either Approve (→ ready, worked by the dispatcher) or
  // Dismiss (archive a false positive). Approve preserves the card's title and
  // findings; the decomposer's path would rewrite them.
  const action = t.status === "triage"
    ? `<button class="btn kb-card-btn" data-action="approve" data-id="${kanbanEsc(t.id)}"
         title="You've reviewed this finding — send it to ready so the dispatcher works it. Moves triage→ready in place; unlike the auto-decomposer it does NOT rewrite the title or findings. Assigns the review-chain default if the card is unassigned.">Approve</button>
       <button class="btn kb-card-btn" data-action="dismiss" data-id="${kanbanEsc(t.id)}"
         title="Dismiss this finding without working it — archives the card. Use for a false positive or a won't-fix.">Dismiss</button>`
    : t.status === "blocked"
    // Unblock retries the work. A blocked card can also be waiting on a DECISION (a
    // [Decision] card) or on land-or-discard ([Applied Fix]); for those there was no way
    // to say "no", so the card could only be unblocked into work nobody wanted.
    ? `<button class="btn kb-card-btn" data-action="unblock" data-id="${kanbanEsc(t.id)}">Unblock</button>
       <button class="btn kb-card-btn" data-action="dismiss" data-id="${kanbanEsc(t.id)}"
         title="Dismiss this card without working it: archives it. Use for a decision you have answered, or a fix you are discarding (its branch is kept).">Dismiss</button>`
    : t.status === "done"
      // One source of truth for the done-card lifecycle: kbCardStage decides the
      // single primary action + chips (Merge / Fix / Submit / Process /
      // Code-the-fix / ✓ submitted / merged / merging). Only the orthogonal,
      // data-driven extras stay here: Promote (staged files), Findings, Archive.
      ? kbDoneControls(t, {noMerge})
        // Left reference files in pool-staging -> Promote them into the shared
        // pool (the data counterpart to Merge; code lands via git, data via this).
        + ((kbStaged[t.id] > 0)
            ? `<button class="btn kb-card-btn kb-land" data-action="promote-refs" data-id="${kanbanEsc(t.id)}"
                 title="This card staged ${kbStaged[t.id]} reference file(s) that aren't in the shared pool yet (the engine can't write it directly). Preview what would land in database/collab_refs (and what has no automatic home), then promote. Never overwrites without confirming.">⤴ Promote refs (${kbStaged[t.id]})</button>`
            : "")
        + `<button class="btn kb-card-btn" data-action="output" data-id="${kanbanEsc(t.id)}"
           title="What this card produced: its completion summary, the structured facts it recorded, the swarm blackboard if it was part of one, and any file it named — checked against disk">Findings</button>
         <button class="btn kb-card-btn" data-action="archive" data-id="${kanbanEsc(t.id)}">Archive</button>`
      : t.status === "running"
        ? `<button class="btn kb-card-btn" data-action="reclaim" data-id="${kanbanEsc(t.id)}"
             title="Kill this card's worker and reset it to ready — the dispatcher then starts a FRESH run on its next pass, which costs another model run. Use when a run is wedged: the worker died, the runtime cap fired, or the model endpoint went away, and the card is still marked running. Does not count as a failure, so the retry limit is unaffected.">Reclaim</button>`
        : "";
  return `<div class="kb-title">${kbChainChip(chain)}${kanbanEsc(chain ? chain.rest : t.title)}</div>
    ${note}${seat}
    <div class="kb-meta"><span class="kb-who">${kanbanEsc(t.assignee) || "—"}</span>
      <span class="kb-meta-r">${diffBadge}${kbDepChips(t)}${comments}<span class="kb-age">${kanbanAge(t)}</span></span></div>
    ${action}`;
}

/* Reconcile one lane's cards in place: update what changed, move what moved,
   remove what's gone. Never rebuilds the list wholesale. */
function kbSyncLane(listEl, tasks){
  const existing = new Map();
  listEl.querySelectorAll(".kb-card").forEach(el => existing.set(el.dataset.id, el));
  let prev = null;
  tasks.forEach(t => {
    let el = existing.get(t.id);
    const sig = kbCardSignature(t);
    if(!el){
      el = document.createElement("div");
      el.className = "kb-card";
      el.dataset.id = t.id;
      el.dataset.sig = sig;
      el.innerHTML = kbCardInner(t);
    }else{
      existing.delete(t.id);
      if(el.dataset.sig !== sig){
        el.dataset.sig = sig;
        el.innerHTML = kbCardInner(t);
      }
    }
    el.classList.toggle("live", t.status === "running");
    el.classList.toggle("archived", t.status === "archived");
    // Toggled outside the signature gate on purpose: elapsed time crosses the
    // threshold with no field on the card changing, so a signature-gated
    // rebuild would never notice it.
    el.classList.toggle("stuck", kbRunningMinutes(t) >= KB_STUCK_MINUTES);
    // insertBefore on a node already in position is a no-op, so a steady
    // board does no DOM work at all — and no DOM work means no scroll jump.
    const want = prev ? prev.nextSibling : listEl.firstChild;
    if(el !== want) listEl.insertBefore(el, want);
    prev = el;
  });
  existing.forEach(el => el.remove());
}

function kbLaneEl(lanesEl, name){
  const found = lanesEl.querySelector(`.kb-lane[data-status="${name}"]`);
  if(found) return found;
  const lane = document.createElement("div");
  lane.className = "kb-lane";
  lane.dataset.status = name;
  lane.innerHTML = `<div class="kb-lane-head" title="Collapse or expand this lane">
      <span class="kb-lane-name">${kanbanEsc(name)}</span>
      <span class="kb-lane-active" hidden></span>
      <span class="kb-lane-count">0</span>
    </div>
    <div class="kb-lane-list"></div>`;
  lanesEl.appendChild(lane);
  return lane;
}

/* Union-find over the parent->child edges. Returns find(id) -> component root
   (an id maps to itself if it has no links). A "family" is one component. */
function kbComponents(edges){
  const parent = new Map();
  function find(x){
    if(!parent.has(x)){ parent.set(x, x); return x; }
    let r = x;
    while(parent.get(r) !== r) r = parent.get(r);
    while(parent.get(x) !== r){ const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  }
  edges.forEach(([p, c]) => { const ra = find(p), rb = find(c); if(ra !== rb) parent.set(ra, rb); });
  return find;
}

/* The family's merge target / header card. A card that already has a real PR
   IS the convergence point, so it wins first (merged over open) -- otherwise a
   sibling with more commits but no PR becomes the lead and the family hides the
   PR's merging/merged state (the "shows Integrate but #9 is already open" bug,
   and the reason the done-lane merging count didn't match the cards). Then most
   commits, then newest. */
function kbFamilyLead(members){
  const prRank = t => { const s = (kbPrs[t.id] || {}).state; return s === "MERGED" ? 2 : s === "OPEN" ? 1 : 0; };
  return members.slice().sort((a, b) => {
    const pa = prRank(a), pb = prRank(b);
    if(pb !== pa) return pb - pa;
    const ca = kbDiffstats[a.id] || 0, cb = kbDiffstats[b.id] || 0;
    if(cb !== ca) return cb - ca;
    return (b.created_at || 0) - (a.created_at || 0);
  })[0];
}

/* The done lane, grouped: each decomposition family becomes one collapsible
   card (lead title + count + the family's single Merge), with members nested
   and collapsed by default. Standalone done cards render flat. Rebuilt only
   when the grouped signature changes (the done lane is not the hot path). */
function kbRenderDoneGrouped(listEl, tasks){
  const find = kbComponents(kbEdges);
  const byRoot = new Map();
  tasks.forEach(t => { const r = find(t.id); (byRoot.get(r) || byRoot.set(r, []).get(r)).push(t); });
  const groups = [...byRoot.values()];
  groups.sort((a, b) => Math.max(...b.map(t => t.created_at || 0)) - Math.max(...a.map(t => t.created_at || 0)));
  const expanded = kbPrefLoad(KB_FAM_KEY, {});
  const parts = [], sig = [];
  const card = (t, opts) => `<div class="kb-card" data-id="${kanbanEsc(t.id)}" data-sig="${kanbanEsc(kbCardSignature(t))}">${kbCardInner(t, opts)}</div>`;
  groups.forEach(members => {
    if(members.length === 1){
      const t = members[0];
      sig.push("s:" + t.id + ":" + kbCardSignature(t));
      sig.push("m:" + JSON.stringify(kbPrs[t.id] || null) + kbDiffstats[t.id]);
      parts.push(card(t));
      return;
    }
    const lead = kbFamilyLead(members);
    const open = !!expanded[lead.id];
    const ordered = [lead, ...members.filter(m => m.id !== lead.id)];
    const chain = kbChainKind(lead);
    const title = chain ? chain.rest : (lead.title || lead.id);
    // Code-bearing members. Two or more branches that aren't already a merged/
    // open PR mean the family may need WEAVING, not just the one converged PR ->
    // offer the agentic merge alongside the programmatic one.
    // Loose code branches nothing has woven yet -> the stage machine offers
    // Integrate on the lead when there are >=2 of these and the lead isn't
    // already converging/an integration card (kbCardStage handles that).
    const codeIds = ordered.filter(t => (kbDiffstats[t.id] || 0) > 0
      && !(kbPrs[t.id] && (kbPrs[t.id].state === "MERGED" || kbPrs[t.id].state === "OPEN"))).map(t => t.id);
    // Make a collapsed family legible: how many wrote code vs analysis, who
    // worked it, and the merged tally -- so you can tell what's inside without
    // expanding.
    const coded = ordered.filter(t => (kbDiffstats[t.id] || 0) > 0).length;
    const mergedN = ordered.filter(t => (kbPrs[t.id] || {}).state === "MERGED").length;
    const whoSet = [...new Set(ordered.map(t => t.assignee).filter(Boolean))];
    const who = whoSet.slice(0, 3).join(", ") + (whoSet.length > 3 ? ` +${whoSet.length - 3}` : "");
    const subBits = [`${ordered.length} cards`];
    if(coded) subBits.push(`${coded} wrote code`);
    const analysis = ordered.length - coded;
    if(analysis) subBits.push(`${analysis} analysis`);
    if(mergedN) subBits.push(`${mergedN} merged`);
    if(who) subBits.push(who);
    const sub = subBits.join(" · ");
    sig.push("f:" + lead.id + ":" + ordered.length + ":" + open + ":" + codeIds.length + ":" + sub + ":"
      + ordered.map(t => t.id + kbCardSignature(t)).join(",") + ":" + JSON.stringify(kbPrs[lead.id] || null)
      + ":rv" + (kbReviews[lead.id] || "") + (kbReviewing.indexOf(lead.id) !== -1 ? "RUN" : "")
      + ":vf" + (kbVerified[lead.id] || ""));
    parts.push(`<div class="kb-family" data-lead="${kanbanEsc(lead.id)}">
      <div class="kb-family-head">
        <span class="kb-fam-toggle">${open ? "▾" : "▸"}</span>
        <div class="kb-fam-main">
          <div class="kb-fam-title" title="${kanbanEsc(lead.title || "")}">${kanbanEsc(title)}</div>
          <div class="kb-fam-sub">${kanbanEsc(sub)}</div>
          <div class="kb-fam-actions">${kbDoneControls(lead, {family: {codeIds, ids: ordered.map(t => t.id)}})}</div>
        </div>
        <span class="kb-chip kb-fam-count" title="${ordered.length} cards in this decomposition">${ordered.length}</span>
      </div>
      <div class="kb-family-members"${open ? "" : " hidden"}>${ordered.map(t => card(t, {noMerge: true})).join("")}</div>
    </div>`);
  });
  const gsig = sig.join("|");
  if(listEl.dataset.gsig !== gsig){ listEl.dataset.gsig = gsig; listEl.innerHTML = parts.join(""); }
}

/* Branch ribbon above the board: a true git graph over TIME. Master is a
   horizontal time axis (oldest → now). Each active branch (one per done family
   lead that wrote code) diverges from master at the card's creation and runs as
   a parallel LINE in an assigned lane -- not a single node, because a branch
   progresses in time. An open/unmerged branch extends to NOW with an end node
   (cyan = open PR/CI, amber = unmerged, hollow); a merged branch rejoins master
   at its real merge time (green). Lanes are packed greedily so non-overlapping
   branches share a row; concurrent ones stack (that's why many open branches
   make it taller -- they genuinely are parallel). Positions use the card
   created_at and the PR createdAt/mergedAt the board already fetches. */
function kbRenderBranchBar(host, tasks){
  if(!host) return;
  const done = (tasks || []).filter(t => t.status === "done");
  const find = kbComponents(kbEdges);
  const byRoot = new Map();
  done.forEach(t => { const r = find(t.id); (byRoot.get(r) || byRoot.set(r, []).get(r)).push(t); });
  const nowS = Date.now() / 1000;
  const toSec = v => { const n = +v; return n > 1e12 ? n / 1000 : n; };          // created_at may be ms or s
  const iso = v => { const m = v ? Date.parse(v) : NaN; return isNaN(m) ? null : m / 1000; };
  let branches = [];
  byRoot.forEach(members => {
    const lead = members.length === 1 ? members[0] : kbFamilyLead(members);
    if((kbDiffstats[lead.id] || 0) > 0){
      const pr = kbPrs[lead.id] || {};
      let state = "unmerged";
      if(pr.state === "MERGED") state = "merged";
      else if(pr.state === "OPEN" || kbLanding.indexOf(lead.id) !== -1) state = "merging";
      const start = toSec(lead.created_at) || nowS;
      const end = (state === "merged" && iso(pr.mergedAt)) ? iso(pr.mergedAt) : nowS;
      branches.push({ id: lead.id, title: kbActTitle(lead), ahead: kbDiffstats[lead.id] || 0,
                      state, pr: pr.number, url: pr.url, start, end: Math.max(end, start) });
    }
  });
  if(!branches.length){ host.hidden = true; host.innerHTML = ""; host.dataset.sig = ""; return; }
  host.hidden = false;

  // Ordered oldest → newest along master (a time SENSE, left to right), but
  // evenly spaced so branches don't pile up when they were all created close
  // together. Each branch is a LINE whose length encodes its progression
  // (commits ahead), diverging off master into a lane, then merged → rejoin
  // master, open → end in a node. Lanes cycle so neighbours never overlap.
  branches.sort((a, b) => a.start - b.start);
  const CAP = 24;
  const overflow = Math.max(0, branches.length - CAP);
  if(overflow) branches = branches.slice(-CAP);   // keep the most recent
  const N = branches.length;
  const maxAhead = Math.max(1, ...branches.map(b => b.ahead));

  const LANES = Math.min(3, N), laneH = 13;
  const W = Math.max(host.clientWidth || 900, 240), mL = 52, mR = 26, spineY = 12, laneTop = 24;
  const H = laneTop + LANES * laneH;
  const sig = W + "|" + overflow + "|" + branches.map(b => b.id + b.state + b.ahead).join(",");
  if(host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const usable = W - mL - mR;
  const step = usable / N;
  const COL = { merged: "var(--teal)", merging: "var(--cyan)", unmerged: "var(--amber)" };
  let g = "";
  branches.forEach((b, i) => {
    const x1 = mL + step * (i + 0.45), c = COL[b.state], lane = i % LANES;
    const y = laneTop + lane * laneH;
    const len = 14 + (b.ahead / maxAhead) * Math.min(step * 1.6, 120);  // progression ∝ commits
    const x2 = x1 + len;
    const label = `${b.state}${b.pr ? " #" + b.pr : ""} · ${b.title} (+${b.ahead} commit${b.ahead === 1 ? "" : "s"})`;
    let d = `M${x1.toFixed(1)},${spineY} C${x1.toFixed(1)},${(spineY+6).toFixed(1)} ${x1.toFixed(1)},${y.toFixed(1)} ${(x1+5).toFixed(1)},${y.toFixed(1)} L${x2.toFixed(1)},${y.toFixed(1)}`;
    let endmark;
    if(b.state === "merged"){
      d += ` C${(x2+6).toFixed(1)},${y.toFixed(1)} ${x2.toFixed(1)},${(spineY+6).toFixed(1)} ${x2.toFixed(1)},${spineY}`;
      endmark = `<circle cx="${x2.toFixed(1)}" cy="${spineY}" r="2.8" fill="${c}"/>`;
    }else{
      const hollow = b.state === "unmerged";
      endmark = `<circle cx="${x2.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${hollow ? "var(--bg)" : c}" stroke="${c}" stroke-width="2"${b.state === "merging" ? ' class="kb-br-live"' : ""}/>`;
    }
    g += `<g class="kb-br" data-id="${kanbanEsc(b.id)}"${b.url ? ` data-url="${kanbanEsc(b.url)}"` : ""}>`
       + `<title>${kanbanEsc(label)}</title><circle cx="${x1.toFixed(1)}" cy="${spineY}" r="2.2" fill="${c}"/>`
       + `<path d="${d}" fill="none" stroke="${c}" stroke-width="2"/>${endmark}</g>`;
  });
  const spine = `<line x1="${mL}" y1="${spineY}" x2="${W-mR}" y2="${spineY}" stroke="var(--txt-dim)" stroke-width="4" stroke-linecap="round"/>`
    + `<path d="M${W-mR+1},${spineY} l-9,-6 v12 z" fill="var(--txt-dim)"/>`
    + `<text x="6" y="${spineY+3.5}" class="kb-br-master">master</text>`
    + `<text x="${W-mR}" y="${spineY-5}" text-anchor="end" class="kb-br-more">now ▸</text>`;
  const more = overflow ? `<text x="${W-mR}" y="${H-2}" text-anchor="end" class="kb-br-more">+${overflow} older</text>` : "";
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${spine}${g}${more}</svg>`;
}

function renderKanban(panel, board, err){
  const lanesEl = panel.querySelector(".kb-lanes");
  const sourceEl = panel.querySelector(".kb-source");
  if(err){
    // A failed poll must not destroy a board that is already on screen.
    //
    // This used to replace every lane with the error text, so one transient
    // blip wiped the board -- and it stayed wiped until a later poll
    // succeeded, up to 15s of showing nothing. The common cause is not the
    // board being down at all: restarting looking-glass.service kills every
    // in-flight fetch, and "Failed to fetch" is what the browser calls that.
    // The board is what you watch WHILE work runs, so the last known good
    // state is far more useful than an error where the cards were.
    //
    // First load is the exception: there is nothing to preserve, so the error
    // is the only thing worth showing.
    const hasCards = lanesEl.querySelector(".kb-card");
    if(hasCards){
      panel.classList.add("kb-stale");
      if(sourceEl){
        sourceEl.innerHTML = `<span class="warn" title="${kanbanEsc(err)}">` +
          `last poll failed — showing the last known board, retrying</span>`;
      }
    }else{
      lanesEl.innerHTML = `<div class="kb-board-err"><span class="err">board unavailable: ${kanbanEsc(err)}</span></div>`;
      if(sourceEl) sourceEl.textContent = "";
    }
    return;
  }
  // Any successful render clears the stale marker.
  panel.classList.remove("kb-stale");
  const tasks = board.tasks || [];
  const columns = (board.columns && board.columns.length)
    ? board.columns : kanbanColumnsFromTasks(tasks);

  // Assignee options come from the board itself, so they can't go stale.
  const sel = panel.querySelector(".kb-assignee");
  const assignees = (board.assignees && board.assignees.length)
    ? board.assignees
    : [...new Set(tasks.map(t => t.assignee).filter(Boolean))].sort();
  const wantOpts = assignees.join("|");
  if(sel.dataset.opts !== wantOpts){
    sel.dataset.opts = wantOpts;
    const keep = sel.value;
    sel.innerHTML = `<option value="">everyone</option>` +
      assignees.map(a => `<option value="${kanbanEsc(a)}">${kanbanEsc(a)}</option>`).join("");
    sel.value = assignees.includes(keep) ? keep : "";
  }
  const filter = sel.value;

  const collapsed = kbPrefLoad(KB_COLLAPSED_KEY, {});
  let shown = 0;
  columns.forEach(col => {
    const lane = kbLaneEl(lanesEl, col.name);
    const list = filter
      ? (col.tasks || []).filter(t => t.assignee === filter)
      : (col.tasks || []);
    lane.querySelector(".kb-lane-count").textContent = list.length;
    // The DONE lane hosts real background processes the vendor's `running` lane
    // can't show: agentic reviews, lands, and open-PR merges (CI). Surface a
    // live count in the lane header so Done isn't just a static pile.
    const actEl = lane.querySelector(".kb-lane-active");
    if(actEl){
      if(col.name === "done"){
        // Only ACTIVE finalizes count as merging -- an open PR that isn't
        // landing/finalizing is stalled, not a running process (matches the
        // cards, which now read "PR #N stalled", not "merging").
        const merging = list.filter(t => (kbPrs[t.id] || {}).state === "OPEN"
          && (kbLanding.indexOf(t.id) !== -1 || kbFinalizing.indexOf(t.id) !== -1)).length;
        const bits = [];
        if(kbReviewing.length) bits.push(kbReviewing.length + " assessing");
        if(merging) bits.push(merging + " merging");
        if(bits.length){ actEl.hidden = false; actEl.textContent = "⟳ " + bits.join(" · ");
          actEl.title = "Background processes on done cards — not kanban workers, so they don't show in the running lane"; }
        else actEl.hidden = true;
      } else actEl.hidden = true;
    }
    // Auto: an empty lane collapses to a rail so the occupied lanes get the
    // width. An explicit click overrides that, in either direction.
    const override = collapsed[col.name];
    const rail = override === undefined ? list.length === 0 : override;
    lane.classList.toggle("rail", rail);
    // Sync even a railed lane. Its list is display:none, so this costs
    // nothing visually, but skipping it left the cards of a lane that had
    // just been filtered or collapsed sitting stale in the DOM — hidden, yet
    // still matching every query over .kb-card.
    if(col.name === "done") kbRenderDoneGrouped(lane.querySelector(".kb-lane-list"), list);
    else kbSyncLane(lane.querySelector(".kb-lane-list"), list);
    shown += list.length;
  });
  // A lane the board has stopped reporting.
  const names = new Set(columns.map(c => c.name));
  lanesEl.querySelectorAll(".kb-lane").forEach(l => {
    if(!names.has(l.dataset.status)) l.remove();
  });

  kbRenderBranchBar(panel.querySelector(".kb-branchbar"), tasks);

  if(sourceEl){
    // Say so when the board came from the ssh fallback: the cards are real
    // either way, but the columns and the richer fields are not there.
    const degraded = board.source === "ssh"
      ? ` <span class="warn" title="${kanbanEsc(board.api_error || "")}">· ssh fallback</span>`
      : "";
    sourceEl.innerHTML = `${shown} card${shown === 1 ? "" : "s"}${degraded}`;
  }
}

/* ---- global dispatch stop -------------------------------------------
   `hermes pause` halts NEW dispatch only: the dispatcher checks it every tick
   BEFORE spawning, in-flight workers are never killed, and cards stay `ready`
   so resuming continues exactly where it stopped. That is the right tool for
   "stop the pipeline" and it was previously only reachable from a shell on
   CT111 -- so the way to stop runaway work FROM THE BOARD was to reclaim
   cards one at a time, killing their workers and losing what they had done.

   A paused board otherwise looks identical to an idle one, which is its own
   trap, so the state is shown as a banner rather than only on the button. */
async function refreshKanbanPause(panel){
  if(typeof plRefreshBadge === "function") plRefreshBadge(panel);
  const btn = panel.querySelector(".kb-pause");
  const banner = panel.querySelector(".kb-paused-banner");
  if(!btn || !banner) return;
  try{
    const r = await fetch("/api/kanban/pause");
    const j = await r.json();
    const paused = !!j.paused;
    btn.dataset.paused = paused ? "1" : "";
    btn.innerHTML = (paused ? lgIcon("play") : lgIcon("pause")) + (paused ? " resume dispatch" : " pause dispatch");
    btn.classList.toggle("on", paused);
    banner.hidden = !paused;
    if(paused){
      banner.innerHTML = `<b>DISPATCH PAUSED</b> — no new workers will start. ` +
        `In-flight work continues and cards stay ready.` +
        (j.reason ? ` <span class="kb-paused-why">${kanbanEsc(j.reason)}</span>` : "");
    }
  }catch{ /* a failed state read must not disturb the board */ }
}

// Same endpoint as the transit map's PROCESS FIX CARD, but auto_land is sent
// as an explicit false: landing to master stays a deliberate opt-in there,
// not something a card button can do. Takes a minute or two (closure review
// is a model run), so the button reports the verdict in place.
async function kbProcessFix(panel, btn){
  btn.disabled = true;
  btn.textContent = "processing…";
  try{
    const r = await fetch("/api/kanban/process-fix-card", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: btn.dataset.id, auto_land: false}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = "failed — retry"; btn.title = j.error || j.escalate_error || ""; return; }
    btn.textContent = `→ ${j.action || "done"}`;
    btn.title = j.reason || "";
    refreshKanbanPanel(panel);
  }catch(err){ btn.disabled = false; btn.textContent = "failed — retry"; btn.title = err.message; }
}

/* One-click merge of a finished card's work to DARKHELIX master. Fires the
   per-card lander (/api/darkhelix/land-auto): open a PR, wait for CI, squash-
   merge if green -- all in the background (the CI wait can run ~30m), so the
   button can only report that landing STARTED. The real outcome shows on the
   card: a successful merge deletes the hermes/<id> branch, so the commit badge
   and this button vanish on the next poll; a CI/size failure moves the card to
   blocked with the reason. skip_review_check: true because these cards are
   landed by an explicit human click here, not via the review lane.

   This merges to master, so it asks once first -- the one guard on the one
   action here that changes the shared repo. */
async function kbLandCard(panel, btn){
  // Guardrail: if the agentic review asked for changes/escalated, don't let a
  // merge slip past it silently -- make the operator acknowledge it.
  const v = kbReviews[btn.dataset.id];
  let warn = "";
  if(v === "request_changes" || v === "escalate")
    warn = `⚠ The agentic review returned "${v}" on this card — merging will land it over that objection.\nConsider "Fix issues" first.\n\n`;
  if(!confirm(warn + "Merge this card's work to DARKHELIX master?\n\nOpens a PR, waits for CI, and squash-merges if green (runs in the background, up to ~30m). If CI fails or the diff is over the size cap, the card is blocked with the reason instead of merging.")) return;
  btn.disabled = true;
  btn.textContent = "landing…";
  try{
    const r = await fetch("/api/darkhelix/land-auto", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: btn.dataset.id, skip_review_check: true}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = "merge failed — retry"; btn.title = j.error || ""; return; }
    btn.textContent = "landing → PR + CI…";
    btn.title = "PR opened; waiting on CI, squash-merges if green (up to ~30m). Watch the card: it moves to blocked with a reason if CI fails, and the branch/badge clear when it merges.";
  }catch(err){ btn.disabled = false; btn.textContent = "merge failed — retry"; btn.title = err.message; }
}

/* Capture a research/analysis card's findings into docs/research/ as a
   machine-readable record (committed to the repo), so future work can query it.
   Opens the RESEARCH view afterward so you can sharpen/accept it. */
async function kbCaptureResearch(panel, btn){
  if(!confirm("Capture this card's findings into docs/research/ (committed to the DARKHELIX repo)?\n\nFor research/analysis cards — turns the summary into a queryable record. Edit it afterward to sharpen the recommendation and tags.")) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "capturing…";
  try{
    const r = await fetch("/api/darkhelix/capture-research", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: btn.dataset.id}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = "capture failed — retry"; btn.title = j.error || ""; return; }
    btn.textContent = "✓ captured";
    btn.title = `Wrote ${j.path}`;
    kbCaptured[btn.dataset.id] = true;
    kbRefreshCaptured(panel);   // re-render so the card shows "✓ submitted" + Archive
    if(typeof openResearch === "function") openResearch();
  }catch(err){ btn.disabled = false; btn.textContent = "capture failed — retry"; btn.title = err.message; }
}

/* Close the loop: dispatch an editor to address the review's requested changes,
   continuing from this card's branch. Files a [Fix] card and runs it; you
   re-Review / re-Verify the result before Merge. */
async function kbFixReview(panel, btn){
  if(!confirm("Dispatch an editor to fix the review's requested changes?\n\nFiles a [Fix] card that continues from this branch, applies the changes, and runs (GPU seat, several minutes). Re-Review and re-Verify the result before merging.")) return;
  btn.disabled = true;
  btn.textContent = "filing fix…";
  try{
    const r = await fetch("/api/darkhelix/fix-review", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: btn.dataset.id}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = "fix failed — retry"; btn.title = j.error || ""; return; }
    btn.textContent = "↻ fixing…";
    btn.title = `Filed ${j.fix_id} (→ ${j.assignee}); it continues from this branch. Watch for the new [Fix] card.`;
    refreshKanbanPanel(panel);
  }catch(err){ btn.disabled = false; btn.textContent = "fix failed — retry"; btn.title = err.message; }
}

/* Agentic (semantic) review of the finished integration: a reviewer model judges
   the whole diff against the card's spec -- coherence, whether the new tests are
   meaningful, and regressions. It's a multi-minute model run, so it runs in the
   BACKGROUND and the verdict (approve/request_changes/escalate + rationale) is
   posted as a card comment. A report, not an action: nothing is merged or moved;
   you read the comment, then Verify/Merge. */
async function kbRequestReview(panel, btn){
  if(!confirm("Run an agentic review of this integration?\n\nA reviewer model judges spec adherence, whether the new tests are meaningful, and regressions. It runs in the background (several minutes) and posts the verdict as a comment on this card. Nothing is merged or moved.")) return;
  btn.disabled = true;
  btn.textContent = "reviewing…";
  try{
    const r = await fetch("/api/darkhelix/request-review", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: btn.dataset.id}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = "review failed — retry"; btn.title = j.error || ""; return; }
    btn.textContent = "⟳ reviewing…";
    btn.title = `Review running (${j.model || "reviewer"}); the verdict will post as a comment on this card in a few minutes.`;
  }catch(err){ btn.disabled = false; btn.textContent = "review failed — retry"; btn.title = err.message; }
}

/* Run the static pre-merge trust check and report the verdict in place. A
   report, not a gate -- you read it, then decide to Merge (which runs CI). */
async function kbVerify(panel, btn){
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "verifying…";
  try{
    const r = await fetch("/api/darkhelix/verify-integration", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_id: btn.dataset.id}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = prev; btn.title = j.error || ""; alert(j.error || "verify failed"); return; }
    btn.disabled = false;
    btn.textContent = j.trustworthy ? "✓ trustworthy" : "⚠ review";
    btn.classList.toggle("kb-verify-ok", j.trustworthy);
    btn.classList.toggle("kb-verify-warn", !j.trustworthy);
    btn.title = `tests +${j.tests_added} lines · source +${j.source_added} lines — ${j.reason}`;
  }catch(err){ btn.disabled = false; btn.textContent = prev; btn.title = err.message; }
}

/* Auto-assessment driver: run after each board refresh. Verifies every
   un-verified done code card (static, instant, no model) and kicks off ONE
   agentic review at a time -- and only while no worker holds the GPU seat, so
   it never competes with a live run (reviewer == engine model, so there is no
   seat swap, only shared throughput). The human still decides Merge / Fix; this
   just means the verdict is already on the card when they look, instead of a
   gate they must click through. Toggle via kbAutoAssessOn. */
/* The cards that can actually merge: one per done family (its lead = the merge
   target) plus standalone done cards, that wrote code. Same grouping the done
   lane and branch ribbon use, so auto-review covers exactly what's mergeable. */
function kbMergeTargets(tasks){
  const done = (tasks || []).filter(t => t.status === "done");
  const find = kbComponents(kbEdges);
  const byRoot = new Map();
  done.forEach(t => { const r = find(t.id); (byRoot.get(r) || byRoot.set(r, []).get(r)).push(t); });
  const leads = [];
  byRoot.forEach(members => {
    const lead = members.length === 1 ? members[0] : kbFamilyLead(members);
    if((kbDiffstats[lead.id] || 0) > 0) leads.push(lead);
  });
  return leads;
}

function kbAutoAssess(tasks){
  if(!kbAutoAssessOn) return;
  // Every merge target that wrote code and hasn't merged yet -- not just
  // [Integrate] cards -- so approved work opens up to a real merge. Already-
  // merged is skipped; an open PR that was never reviewed (e.g. an old straggler)
  // still gets a verdict.
  const cands = kbMergeTargets(tasks).filter(t =>
    !(kbPrs[t.id] && kbPrs[t.id].state === "MERGED"));
  // Static verify: cheap and model-free, so run it for every un-verified card.
  cands.forEach(t => {
    if(kbVerified[t.id] === undefined && kbVerifyInflight.indexOf(t.id) === -1) kbAutoVerify(t.id);
  });
  // Agentic review: one at a time, and never while a worker is generating.
  const seatBusy = (tasks || []).some(t => t.status === "running");
  if(seatBusy || kbReviewing.length || kbAutoReviewInflight.length) return;
  const next = cands.find(t => !kbReviews[t.id] && kbAutoReviewInflight.indexOf(t.id) === -1);
  if(next) kbAutoReview(next.id);
}

function kbAutoVerify(id){
  kbVerifyInflight.push(id);
  fetch("/api/darkhelix/verify-integration", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({task_id: id}),
  }).then(r => r.json()).then(j => {
    // "err" is a sentinel: attempted, verdict unknown. It shows no chip but
    // stops the per-poll retry from re-hitting snarf's git calls on a bad card.
    kbVerified[id] = (j && j.ok) ? (j.trustworthy ? "pass" : "fail") : "err";
  }).catch(() => { kbVerified[id] = "err"; })
    .finally(() => { kbVerifyInflight = kbVerifyInflight.filter(x => x !== id); });
}

function kbAutoReview(id){
  kbAutoReviewInflight.push(id);
  fetch("/api/darkhelix/request-review", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({task_id: id}),
  }).then(r => r.json()).then(j => {
    // The server owns the 'reviewing' state (kbReviewing, refreshed from
    // /api/kanban/links); nudge it locally so the chip shows until the next poll.
    if(j && j.ok && kbReviewing.indexOf(id) === -1) kbReviewing.push(id);
  }).catch(() => {})
    .finally(() => { kbAutoReviewInflight = kbAutoReviewInflight.filter(x => x !== id); });
}

/* Emit real agent work into the AGENT ACTIVITY feed by diffing each poll
   against the last: workers dispatched/finished, reviews started/returned, PRs
   opened/merged. The first poll seeds state silently so opening the board
   doesn't replay the whole backlog. Reuses addActivity() from app.js. */
function kbActTitle(t){
  const c = kbChainKind(t);
  let s = ((c ? c.rest : (t && t.title)) || (t && t.id) || "").replace(/^\[(Integrate|Fix|Review)\]\s*/, "");
  return s.length > 46 ? s.slice(0, 45) + "…" : s;
}
function kbTrackActivity(tasks){
  if(typeof addActivity !== "function") return;
  const byId = {}; (tasks || []).forEach(t => { byId[t.id] = t; });
  const titleOf = id => byId[id] ? kbActTitle(byId[id]) : id;
  const running = {}, reviewing = {}, prState = {};
  (tasks || []).forEach(t => { if(t.status === "running") running[t.id] = kbActTitle(t); });
  kbReviewing.forEach(id => { reviewing[id] = true; });
  Object.keys(kbPrs).forEach(id => { const pr = kbPrs[id]; if(pr && pr.state) prState[id] = pr.state; });

  if(!kbActSeeded){
    // Seed: show what's happening NOW so the panel reflects live agent work on
    // load, not a blank until the next transition.
    Object.keys(running).forEach(id => addActivity("running · " + running[id]));
    Object.keys(reviewing).forEach(id => addActivity("reviewing · " + titleOf(id)));
  }else{
    Object.keys(running).forEach(id => { if(!kbPrevRunning[id]) addActivity("dispatched · " + running[id]); });
    Object.keys(kbPrevRunning).forEach(id => { if(!running[id]) addActivity("worker done · " + kbPrevRunning[id]); });
    Object.keys(reviewing).forEach(id => { if(!kbPrevReviewing[id]) addActivity("reviewing · " + titleOf(id)); });
    Object.keys(kbPrevReviewing).forEach(id => { if(!reviewing[id]) addActivity("review " + (kbReviews[id] || "done") + " · " + titleOf(id)); });
    Object.keys(prState).forEach(id => {
      if(kbPrevPrState[id] !== prState[id]){
        const n = (kbPrs[id] || {}).number || "?";
        if(prState[id] === "OPEN") addActivity("merging #" + n + " · " + titleOf(id));
        else if(prState[id] === "MERGED") addActivity("merged #" + n + " · " + titleOf(id));
      }
    });
  }
  kbPrevRunning = running; kbPrevReviewing = reviewing; kbPrevPrState = prState; kbActSeeded = true;
}

/* Always-on, lightweight feed poll so AGENT ACTIVITY stays live even when the
   kanban tab is closed. Fetches only tasks + links (NOT the git-heavy
   diffstats); PR-merge transitions still arrive via the board's own poll when
   it's open. kbTrackActivity is idempotent (it advances kbPrev* each call), so
   running it here and in refreshKanbanPanel cannot double-emit. */
async function kbActivityPoll(){
  try{
    const [tr, lr] = await Promise.all([
      fetch("/api/kanban").catch(() => null),
      fetch("/api/kanban/links").catch(() => null),
    ]);
    let tasks = [];
    if(tr && tr.ok){ try{ tasks = (await tr.json()).tasks || []; }catch{ /* keep */ } }
    if(lr && lr.ok){ try{ const lj = await lr.json(); kbReviewing = lj.reviewing || kbReviewing; kbReviews = lj.reviews || kbReviews; }catch{ /* keep */ } }
    kbTrackActivity(tasks);
  }catch{ /* leave the feed as-is */ }
}
setInterval(kbActivityPoll, 20000);

/* Which done cards already have a docs/research record (by card_id). Refreshed
   on board open and after a capture; a card in here shows "✓ submitted". */
async function kbRefreshCaptured(panel){
  try{
    const r = await fetch("/api/darkhelix/research");
    const j = await r.json();
    const map = {};
    (j.records || []).forEach(rec => { if(rec.card_id) map[rec.card_id] = true; });
    kbCaptured = map;
    if(panel) refreshKanbanPanel(panel);
  }catch{ /* leave the flags as-is */ }
}

/* Archive every card in a merged family in one go -- the done lane keeps the
   whole decomposition around after it lands, which is clutter once it's in
   master. Archives each member (the archive endpoint is per-card). */
async function kbArchiveFamily(panel, btn){
  const ids = (btn.dataset.ids || "").split(",").filter(Boolean);
  if(!ids.length) return;
  if(!confirm(`Archive this merged family — all ${ids.length} cards move to the archived lane?`)) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "archiving…";
  try{
    for(const id of ids){
      await fetch("/api/kanban/archive", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({task_id: id}),
      });
    }
    refreshKanbanPanel(panel);
  }catch(err){ btn.disabled = false; btn.textContent = prev + " — retry"; btn.title = err.message; }
}

/* Agentic merge: file an [Integrate] card parented to a family's code branches
   and dispatch an editor to weave them into one coherent change WITH tests. The
   result is an ordinary [Integrate] card you review and Merge (CI-gated), so an
   untrustworthy integration fails to merge rather than slipping through. For new
   features where the branches must be integrated, not just one converged PR. */
async function kbAgenticIntegrate(panel, btn){
  const ids = (btn.dataset.ids || "").split(",").filter(Boolean);
  const title = btn.dataset.title || "";
  if(ids.length < 2){ alert("Need at least two code-bearing cards to integrate."); return; }
  if(!confirm(`Agentic merge: dispatch an editor to weave ${ids.length} branches into one coherent change WITH tests?\n\n`
    + `It runs as a worker (GPU seat, several minutes) and produces an [Integrate] card. You then review its diff + tests and Merge it (CI-gated). Sources:\n  `
    + ids.join("\n  "))) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "filing…";
  try{
    const r = await fetch("/api/darkhelix/agentic-integrate", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({task_ids: ids, title}),
    });
    const j = await r.json();
    if(!j.ok){ btn.disabled = false; btn.textContent = "failed — retry"; btn.title = j.error || ""; return; }
    btn.textContent = "⚙ integrating…";
    btn.title = `Filed ${j.integrate_id}, dispatched to ${j.assignee}. Watch for the [Integrate] card; review its diff + tests, then Merge.`;
    refreshKanbanPanel(panel);
  }catch(err){ btn.disabled = false; btn.textContent = "failed — retry"; btn.title = err.message; }
}

/* Merge everything mergeable at once. The merge targets are exactly the land
   buttons currently in the done lane -- one per family (its lead) and one per
   standalone done card; members carry no button, so a family lands as one.
   Fires the per-card lander for each (background); any that fail CI/size land
   in blocked with a reason, same as a single Merge. */
async function kbMergeAll(panel, btn){
  const targets = [...panel.querySelectorAll('.kb-lane[data-status="done"] [data-action="land"]')]
    .map(b => b.dataset.id).filter(Boolean);
  if(!targets.length){ alert("Nothing mergeable — no family or card has unmerged code without an open/merged PR."); return; }
  if(!confirm(`Merge ${targets.length} item(s) to DARKHELIX master?\n\nEach opens a PR, waits for CI, and squash-merges if green (background, up to ~30m each). Any that fail CI or exceed the size cap are left blocked with the reason.`)) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = `merging ${targets.length}…`;
  let ok = 0, fail = 0;
  for(const id of targets){
    try{
      const r = await fetch("/api/darkhelix/land-auto", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({task_id: id, skip_review_check: true}),
      });
      const j = await r.json();
      if(j.ok) ok++; else fail++;
    }catch{ fail++; }
  }
  btn.textContent = `started ${ok}${fail ? ` · ${fail} failed` : ""}`;
  setTimeout(() => { btn.disabled = false; btn.textContent = prev; refreshKanbanPanel(panel); }, 3000);
}

/* Promote a card's STAGED reference files into the shared DARKHELIX pool. The
   data counterpart to Merge: a card can't write the read-only pool itself, so
   it leaves files in pool-staging and this copies them in (gated, md5-verified,
   never clobbers without an explicit yes).

   Two-phase and honest about files with nowhere to go: a dry-run first shows
   what WOULD land in collab_refs, what would be overwritten, and what is
   "refused" -- i.e. has no automatic home (wrong type, or belongs in another
   database/ subdir). Those are reported, never silently dropped; you place them
   by hand. Only after you confirm does the real copy run. */
async function kbPromoteRefs(panel, btn){
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "checking…";
  const post = (body) => fetch("/api/darkhelix/promote-refs", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify(Object.assign({task_id: btn.dataset.id}, body)),
  }).then(r => r.json());
  try{
    const d = await post({dry_run: true});
    if(!d.ok){
      btn.disabled = false; btn.textContent = prev; btn.title = d.error || "";
      alert(d.error || "Nothing staged to promote for this card."); return;
    }
    const land = d.would_promote || [], over = d.would_overwrite || [], refused = d.refused || [];
    if(!land.length){
      btn.disabled = false; btn.textContent = prev;
      alert("None of the staged files have an automatic home in the pool"
        + " (collab_refs accepts genome/table types only).\n\nNo home — place by hand:\n  "
        + (refused.join("\n  ") || "(none)"));
      return;
    }
    let msg = `Promote ${land.length} file(s) to ${d.destination}:\n  ` + land.join("\n  ");
    if(over.length) msg += `\n\n⚠ ${over.length} would OVERWRITE existing pool file(s):\n  ` + over.join("\n  ");
    if(refused.length) msg += `\n\n✖ ${refused.length} have no automatic home — you'll be asked where to put them next:\n  ` + refused.join("\n  ");
    msg += over.length ? "\n\nProceed, including the overwrites?" : "\n\nProceed?";
    if(!confirm(msg)){ btn.disabled = false; btn.textContent = prev; return; }
    btn.textContent = "promoting…";
    const p = await post({files: land, overwrite: over.length > 0});
    if(!p.ok){ btn.disabled = false; btn.textContent = "promote failed — retry"; btn.title = p.error || ""; return; }
    const done = [...(p.promoted || [])];

    // Place the no-home files: ask once for a destination under database/ and
    // put them there (any extension, same no-clobber/md5 safety server-side).
    if(refused.length){
      const dest = prompt(
        `Where should these ${refused.length} file(s) go? Path under the repo, must start with "database/" (e.g. database/toxin_hmm):\n  `
        + refused.join("\n  "),
        "database/");
      if(dest && dest.trim()){
        const q = await post({files: refused, dest: dest.trim(), allow_any_ext: true});
        if(!q.ok && (q.existing || []).length && confirm(
            `${(q.existing||[]).length} already exist in ${dest.trim()} and would be overwritten:\n  `
            + (q.existing||[]).join("\n  ") + "\n\nOverwrite them?")){
          const q2 = await post({files: refused, dest: dest.trim(), allow_any_ext: true, overwrite: true});
          if(q2.ok) done.push(...(q2.promoted || []));
          else { btn.title = q2.error || ""; }
        } else if(q.ok){ done.push(...(q.promoted || [])); }
        else { btn.title = q.error || ""; }
      }
    }

    btn.textContent = `✓ promoted ${done.length}`;
    btn.title = `Placed: ${done.join(", ") || "none"}`;
    refreshKanbanPanel(panel);
  }catch(err){ btn.disabled = false; btn.textContent = "promote failed — retry"; btn.title = err.message; }
}

/* card_id -> true if it has a child [Fix] card that hasn't finished, so a
   flagged card reads "fixing…" while its fix is in flight. */
function kbComputeFixInFlight(tasks){
  const byId = {};
  (tasks || []).forEach(t => { byId[t.id] = t; });
  const inflight = {};
  (kbEdges || []).forEach(([p, c]) => {
    const child = byId[c];
    if(child && (child.title || "").startsWith("[Fix]") && child.status !== "done" && child.status !== "archived")
      inflight[p] = true;
  });
  return inflight;
}

/* A reviewed card whose [Fix] already FINISHED keeps its old request_changes
   verdict, which used to make the board offer "Fix issues" again and fork a
   sibling from the unmerged root (three competing genome_discovery refactors).
   Likewise a source set that already has a live [Integrate] must not offer
   Integrate again. Both are read off the same edges the in-flight map uses. */
function kbComputeLinkedWork(tasks){
  const byId = {};
  (tasks || []).forEach(t => { byId[t.id] = t; });
  const fixedBy = {}, integratedBy = {};
  (kbEdges || []).forEach(([p, c]) => {
    const ch = byId[c];
    if(!ch || ch.status === "archived") return;
    const title = ch.title || "";
    if(title.startsWith("[Fix]") && ch.status === "done") fixedBy[p] = c;
    if(title.startsWith("[Integrate]")) integratedBy[p] = c;
  });
  return {fixedBy, integratedBy};
}

async function refreshKanbanPanel(panel){
  refreshKanbanPause(panel);
  try{
    // Board and diff stats in parallel. Diff stats are server-cached for a
    // tick, so polling them every refresh is cheap; a failure just leaves the
    // "no diff" badges off, never breaks the board.
    const showArch = kbPrefLoad(KB_ARCHIVED_KEY, false);
    const [r, dr, lr] = await Promise.all([
      fetch("/api/kanban" + (showArch ? "?archived=1" : "")),
      fetch("/api/kanban/diffstats").catch(() => null),
      fetch("/api/kanban/links").catch(() => null),
    ]);
    const j = await r.json();
    if(dr && dr.ok){
      try{ const dj = await dr.json(); kbDiffstats = dj.diffstats || {}; kbStaged = dj.staged || {}; kbPrs = dj.prs || {}; kbLanding = dj.landing || []; kbFinalizing = dj.finalizing || []; }catch{ /* keep last */ }
    }
    if(lr && lr.ok){ try{ const lj = await lr.json(); kbEdges = lj.edges || []; kbReviews = lj.reviews || {}; kbReviewing = lj.reviewing || []; }catch{ /* keep last */ } }
    kbFixInFlight = kbComputeFixInFlight(j.tasks || []);   // needs kbEdges (just set)
    { const lw = kbComputeLinkedWork(j.tasks || []); kbFixedBy = lw.fixedBy; kbIntegratedBy = lw.integratedBy; }
    if((j.tasks || []).some(t => t.status === "running")) await kbRefreshSeat();
    renderKanban(panel, j, j.error);
    // Fire-and-forget: verify + review the done code cards so their verdicts are
    // already on the card, not a gate the human clicks through. Results land in
    // kbVerified / kbReviews and show on the next poll (or sooner, below).
    kbAutoAssess(j.tasks || []);
    // Feed real agent work (dispatches / reviews / merges) into AGENT ACTIVITY.
    kbTrackActivity(j.tasks || []);
  }catch(err){ renderKanban(panel, {}, err.message); }
}

function openKanbanBoard(){
  openWorkTabTurning("kanban","board","KANBAN",(panel,tab)=>{
    panel.innerHTML = `<div class="kb-head">
        <span class="kb-head-title">BOARD</span>
        <span class="kb-source">loading…</span>
        <button class="kb-head-help" type="button" aria-label="Board legend" title="click a card for its run log  ·  ⛓ = waiting on unfinished parents  ·  n/m = children done  ·  REVIEW/FIX = review chain">ⓘ</button>
        <span class="kb-head-spacer"></span>
        <label class="kb-filter">assignee <select class="kb-assignee"></select></label>
        <span class="kb-head-group">
          <button class="kb-learning" type="button" title="Lessons Hermes workers tried to save (memory/skills) that need a decision. Audited by Claude daily at 05:00; click to review.">${lgIcon("idea")} … pending learning</button>
          <button class="kb-merge-all" type="button" title="Merge every unmerged, mergeable family/card to DARKHELIX master at once — each opens a PR, waits for CI, squash-merges if green (background). Asks once.">${lgIcon("merge")} merge all</button>
          <button class="kb-arch-toggle" type="button" title="Show the archived lane — merged cards (auto-archived on merge) and dismissed ones live here.">${lgIcon("archive")} archived</button>
          <button class="kb-pause" type="button" title="Halt NEW dispatch. In-flight workers are never killed and cards stay ready, so resuming picks up exactly where it left off.">${lgIcon("pause")} pause dispatch</button>
        </span>
      </div>
      <div class="kb-paused-banner" hidden></div>
      <div class="kb-branchbar" hidden title="Active DARKHELIX branches vs master — green=merged, cyan=open PR (CI), amber=unmerged. Click a branch for its card / PR."></div>
      <div class="kb-lanes"></div>`;
    panel.classList.add("kanban-pane");
    const learnBtn = panel.querySelector(".kb-learning");
    if(learnBtn) learnBtn.onclick = () => { if(typeof openPendingLearning === "function") openPendingLearning(); };

    // One delegated listener for the whole board — card clicks, action
    // buttons and lane collapse. Re-binding per card on every poll was both
    // wasteful and a way to leak handlers onto reused nodes.
    const lanesEl = panel.querySelector(".kb-lanes");
    lanesEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".kb-card-btn");
      if(btn){
        e.stopPropagation();
        // Findings opens a pane; the rest POST to the board and rewrite the
        // button in place, which is why they go through a different path.
        if(btn.dataset.action === "output"){ openTaskOutput(btn.dataset.id); return; }
        if(btn.dataset.action === "process-fix"){ kbProcessFix(panel, btn); return; }
        if(btn.dataset.action === "land"){ kbLandCard(panel, btn); return; }
        if(btn.dataset.action === "promote-refs"){ kbPromoteRefs(panel, btn); return; }
        if(btn.dataset.action === "integrate"){ kbAgenticIntegrate(panel, btn); return; }
        if(btn.dataset.action === "archive-family"){ kbArchiveFamily(panel, btn); return; }
        if(btn.dataset.action === "verify"){ kbVerify(panel, btn); return; }
        if(btn.dataset.action === "request-review"){ kbRequestReview(panel, btn); return; }
        if(btn.dataset.action === "fix-review"){ kbFixReview(panel, btn); return; }
        if(btn.dataset.action === "capture-research"){ kbCaptureResearch(panel, btn); return; }
        const act = KB_CARD_ACTIONS[btn.dataset.action];
        if(act) kanbanCardAction(panel, act.endpoint, act.verb, btn.dataset.id, btn);
        return;
      }
      // Expand/collapse a decomposition family (anywhere on its head except the
      // merge button, which the .kb-card-btn branch above already handled).
      const famHead = e.target.closest(".kb-family-head");
      if(famHead){
        const fam = famHead.closest(".kb-family");
        const lead = fam && fam.dataset.lead;
        if(lead){
          const exp = kbPrefLoad(KB_FAM_KEY, {});
          const open = !exp[lead];
          if(open) exp[lead] = true; else delete exp[lead];
          kbPrefSave(KB_FAM_KEY, exp);
          const members = fam.querySelector(".kb-family-members");
          if(members) members.hidden = !open;
          const tog = famHead.querySelector(".kb-fam-toggle");
          if(tog) tog.textContent = open ? "▾" : "▸";
        }
        return;
      }
      const head = e.target.closest(".kb-lane-head");
      if(head){
        const lane = head.closest(".kb-lane");
        const collapsed = kbPrefLoad(KB_COLLAPSED_KEY, {});
        collapsed[lane.dataset.status] = !lane.classList.contains("rail");
        kbPrefSave(KB_COLLAPSED_KEY, collapsed);
        refreshKanbanPanel(panel);
        return;
      }
      const card = e.target.closest(".kb-card");
      if(card) openTaskLog(card.dataset.id);
    });

    // Branch ribbon: click a branch to open its PR (if it has one) or its card.
    const branchbar = panel.querySelector(".kb-branchbar");
    if(branchbar) branchbar.addEventListener("click", (e) => {
      const br = e.target.closest(".kb-br");
      if(!br) return;
      if(br.dataset.url) window.open(br.dataset.url, "_blank", "noopener");
      else if(br.dataset.id) openTaskLog(br.dataset.id);
    });

    const pauseBtn = panel.querySelector(".kb-pause");
    pauseBtn.onclick = async () => {
      // Send the explicit target state, never a toggle: a toggle read off a
      // stale board does the opposite of what was intended, and this is the
      // control you reach for when something is already going wrong.
      const want = pauseBtn.dataset.paused !== "1";
      pauseBtn.disabled = true;
      const prev = pauseBtn.textContent;
      pauseBtn.textContent = want ? "pausing…" : "resuming…";
      try{
        const r = await fetch("/api/kanban/pause", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({paused: want,
                                reason: "paused from the Looking Glass board"}),
        });
        const j = await r.json();
        if(!j.ok) pauseBtn.textContent = prev + " — failed";
      }catch{ pauseBtn.textContent = prev + " — failed"; }
      pauseBtn.disabled = false;
      refreshKanbanPause(panel);
      refreshKanbanPanel(panel);
    };

    const mergeAllBtn = panel.querySelector(".kb-merge-all");
    if(mergeAllBtn) mergeAllBtn.onclick = () => kbMergeAll(panel, mergeAllBtn);

    const archBtn = panel.querySelector(".kb-arch-toggle");
    if(archBtn){
      const sync = () => {
        const on = kbPrefLoad(KB_ARCHIVED_KEY, false);
        archBtn.classList.toggle("on", on);
        archBtn.innerHTML = lgIcon("archive") + (on ? " hide archived" : " archived");
      };
      sync();
      archBtn.onclick = () => {
        kbPrefSave(KB_ARCHIVED_KEY, !kbPrefLoad(KB_ARCHIVED_KEY, false));
        sync();
        refreshKanbanPanel(panel);
      };
    }

    const sel = panel.querySelector(".kb-assignee");
    sel.value = kbPrefLoad(KB_ASSIGNEE_KEY, "") || "";
    sel.onchange = () => { kbPrefSave(KB_ASSIGNEE_KEY, sel.value); refreshKanbanPanel(panel); };

    refreshKanbanPanel(panel);
    kbRefreshCaptured(panel);   // which analysis cards already have a research record
    // Cards change state on the dispatcher's tick; keep it current but light.
    const iv = setInterval(()=>refreshKanbanPanel(panel), 15000);
    tab.onBeforeClose = () => clearInterval(iv);
  });
}

/* ---------------------------- VERIFY ---------------------------------
   Running a card's work is one thing; checking it held is another, and that
   check needs a live session on snarf -- DARKHELIX lives there and no other
   box can see it. Doing it with an agent costs a full model run; the repo's
   own suite is ~600 tests in ~45s with no model involved. This runs one of
   the server's named checks (server.py's DARKHELIX_CHECKS -- the card never
   supplies a command) and can file the verdict back as a comment, so the
   result outlives this pane and a retrying worker can read it.
===================================================================== */
async function kbWireVerify(panel, taskId){
  const sel = panel.querySelector(".kb-verify-check");
  const btn = panel.querySelector(".kb-verify-btn");
  const status = panel.querySelector(".kb-verify-status");
  const out = panel.querySelector(".kb-verify-out");
  try{
    const r = await fetch("/api/darkhelix/checks");
    const j = await r.json();
    const checks = j.checks || [];
    if(!checks.length){ sel.innerHTML = `<option value="">none available</option>`; return; }
    sel.innerHTML = checks.map(c =>
      `<option value="${kanbanEsc(c.id)}">${kanbanEsc(c.label)}</option>`).join("");
    btn.disabled = false;
  }catch(err){
    sel.innerHTML = `<option value="">unavailable</option>`;
    status.innerHTML = `<span class="err">${kanbanEsc(err.message)}</span>`;
    return;
  }
  btn.onclick = async () => {
    const check = sel.value;
    if(!check) return;
    btn.disabled = true;
    const label = sel.options[sel.selectedIndex].textContent;
    status.innerHTML = `<span class="warn">running ${kanbanEsc(label)} on snarf…</span>`;
    out.hidden = true;
    try{
      const r = await fetch("/api/darkhelix/verify", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          check, task_id: taskId,
          comment: panel.querySelector(".kb-verify-file input").checked,
        }),
      });
      const j = await r.json();
      if(j.error){
        status.innerHTML = `<span class="err">${kanbanEsc(j.error)}</span>`;
      }else{
        const verdict = j.ok
          ? `<span class="ok">passed in ${j.elapsed}s</span>`
          : `<span class="err">failed (exit ${j.rc}) in ${j.elapsed}s</span>`;
        const filed = j.commented ? ` · filed on the card` :
                      j.comment_error ? ` · <span class="warn">not filed</span>` : "";
        status.innerHTML = verdict + filed;
        out.textContent = j.output || "(no output)";
        out.hidden = false;
        out.scrollTop = out.scrollHeight;
      }
    }catch(err){
      status.innerHTML = `<span class="err">${kanbanEsc(err.message)}</span>`;
    }
    btn.disabled = false;
  };

  /* Land: verify -> commit -> push -> PR, on the card's own worktree.
     A failed check stops before the push (DARKHELIX's pre-push hook would
     refuse it anyway) and reroutes the card back onto the board with the
     reason attached, rather than failing silently off-screen. */
  const landBtn = panel.querySelector(".kb-land-btn");
  landBtn.onclick = async () => {
    landBtn.disabled = true; btn.disabled = true;
    status.innerHTML = `<span class="warn">landing — verify, commit, push…</span>`;
    out.hidden = true;
    try{
      const r = await fetch("/api/darkhelix/land", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({task_id: taskId, check: sel.value || "tests"}),
      });
      const j = await r.json();
      const lines = (j.steps || []).map(st =>
        `${st.ok ? "ok  " : "FAIL"}  ${st.stage}${st.rc === null || st.rc === undefined ? "" : "  (rc " + st.rc + ")"}`);
      if(j.pr_url) lines.push("", "pull request: " + j.pr_url);
      if(j.branch) lines.push("branch: " + j.branch);
      const last = (j.steps || [])[j.steps.length - 1];
      if(last && last.detail) lines.push("", last.detail);
      out.textContent = lines.join("\n");
      out.hidden = false;

      if(j.ok && j.pr_url){
        status.innerHTML = `<span class="ok">landed</span> · <a href="${kanbanEsc(j.pr_url)}" target="_blank" rel="noreferrer">PR</a>`;
      }else if(j.ok){
        status.innerHTML = `<span class="ok">pushed ${kanbanEsc(j.branch || "")}</span>` +
          (j.pr_skipped ? ` · no PR (${kanbanEsc(j.pr_skipped)})` : "");
      }else{
        const routed = j.rerouted_to_kanban === "blocked" ? "card blocked on the board"
                     : j.rerouted_to_kanban === "commented" ? "reason filed on the card"
                     : "NOT recorded on the card";
        status.innerHTML = `<span class="err">stopped at ${kanbanEsc(j.stage || "?")}</span> · ${routed}`;
        refreshOpenKanbanBoards();
      }
    }catch(err){
      status.innerHTML = `<span class="err">${kanbanEsc(err.message)}</span>`;
    }
    landBtn.disabled = false; btn.disabled = false;
  };

  /* Land Autonomously: same verify -> commit -> push -> PR as the button
     above, then wait for the PR's own CI and merge on green -- no further
     click. Runs in the background on the server (a CI wait can take a long
     time), so this fires the request, then polls the shared status feed for
     THIS card's outcome rather than waiting on the fetch itself. */
  const autoBtn = panel.querySelector(".kb-autoland-btn");
  let autoPoll = null;
  autoBtn.onclick = async () => {
    if(autoPoll) return;
    autoBtn.disabled = true; landBtn.disabled = true; btn.disabled = true;
    status.innerHTML = `<span class="warn">starting autonomous land…</span>`;
    out.hidden = true;
    try{
      const r = await fetch("/api/darkhelix/land-auto", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({task_id: taskId}),
      });
      const j = await r.json();
      if(!j.ok){
        status.innerHTML = `<span class="err">${kanbanEsc(j.error || "failed to start")}</span>`;
        autoBtn.disabled = false; landBtn.disabled = false; btn.disabled = false;
        return;
      }
      status.innerHTML = `<span class="warn">landing — verify, push, PR, then waiting on CI…</span>`;
      const started = Date.now();
      autoPoll = setInterval(async () => {
        try{
          const sr = await fetch("/api/kanban/land-darkhelix");
          const sj = await sr.json();
          const mine = (sj.recent || []).find(e => e.task_id === taskId && e.trigger === "manual"
                                                    && e.at * 1000 >= started);
          if(!mine) return;
          if(mine.verdict === "merged"){
            status.innerHTML = `<span class="ok">merged</span>` +
              (mine.pr_url ? ` · <a href="${kanbanEsc(mine.pr_url)}" target="_blank" rel="noreferrer">PR</a>` : "");
            clearInterval(autoPoll); autoPoll = null;
            autoBtn.disabled = false; landBtn.disabled = false; btn.disabled = false;
            refreshOpenKanbanBoards();
          }else if(mine.verdict === "blocked" || mine.verdict === "error"){
            status.innerHTML = `<span class="err">stopped at ${kanbanEsc(mine.stage || mine.verdict)}</span>` +
              (mine.pr_url ? ` · <a href="${kanbanEsc(mine.pr_url)}" target="_blank" rel="noreferrer">PR</a> left open for a human` : "") +
              (mine.error ? ` · ${kanbanEsc(mine.error)}` : "");
            clearInterval(autoPoll); autoPoll = null;
            autoBtn.disabled = false; landBtn.disabled = false; btn.disabled = false;
            refreshOpenKanbanBoards();
          }
        }catch{ /* transient poll failure -- try again next tick */ }
      }, 5000);
    }catch(err){
      status.innerHTML = `<span class="err">${kanbanEsc(err.message)}</span>`;
      autoBtn.disabled = false; landBtn.disabled = false; btn.disabled = false;
    }
  };
}

/* A land that reroutes changes the board, so any open board pane should show
   it without waiting out its 15s poll. */
function refreshOpenKanbanBoards(){
  document.querySelectorAll(".work-panel.kanban-pane").forEach(p => refreshKanbanPanel(p));
}

/* ---- editing a card from the board -----------------------------------
   The diagnosis loop turns on amending a spec — a red test gate usually means
   the card was short — and the worker can do that via
   dispatch_to_engine(amended_description=...). A HUMAN could not: there was no
   way to edit a card from the board in any status. "Amend the card and unblock
   it" was advice with no field to type into.

   Collapsed by default: this pane is for watching a run, and an always-open
   textarea over the log would be the wrong default. */
function kbWireEdit(panel, taskId){
  const toggle = panel.querySelector(".kb-edit-toggle");
  const body   = panel.querySelector(".kb-edit-body");
  const text   = panel.querySelector(".kb-edit-text");
  const status = panel.querySelector(".kb-edit-status");
  const say = (msg, cls) => { status.innerHTML = cls ? `<span class="${cls}">${kanbanEsc(msg)}</span>` : kanbanEsc(msg); };

  // The stored body carries the machine-written dispatch-target block. Editing
  // is offered on the task text only, so it cannot be clobbered by hand; the
  // server re-attaches it on save.
  const stripTarget = (b) => (b || "").replace(/\[dispatch-target\][\s\S]*?\[\/dispatch-target\]\s*/, "").trim();

  const load = async () => {
    try{
      const r = await fetch(`/api/kanban/${encodeURIComponent(taskId)}`);
      const j = await r.json();
      text.value = stripTarget((j.task || {}).body);
      text.placeholder = "";
    }catch(err){ say("could not load: " + err.message, "err"); }
  };

  toggle.onclick = () => {
    const opening = body.hidden;
    body.hidden = !opening;
    toggle.textContent = opening ? "edit ▴" : "edit ▾";
    if(opening && !text.value) load();
  };

  panel.querySelector(".kb-edit-cancel").onclick = () => {
    body.hidden = true; toggle.textContent = "edit ▾"; say(""); load();
  };

  panel.querySelector(".kb-edit-save").onclick = async () => {
    const btn = panel.querySelector(".kb-edit-save");
    btn.disabled = true; say("saving…", "warn");
    try{
      const r = await fetch(`/api/kanban/${encodeURIComponent(taskId)}/edit`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({body: text.value}),
      });
      const j = await r.json();
      say(j.ok ? "spec saved — unblock or reclaim the card to retry with it"
               : "save failed: " + (j.error || "unknown"), j.ok ? "ok" : "err");
    }catch(err){ say("save failed: " + err.message, "err"); }
    btn.disabled = false;
  };

  panel.querySelector(".kb-comment-add").onclick = async () => {
    const input = panel.querySelector(".kb-comment-text");
    const val = input.value.trim();
    if(!val) return;
    const btn = panel.querySelector(".kb-comment-add");
    btn.disabled = true; say("commenting…", "warn");
    try{
      const r = await fetch(`/api/kanban/${encodeURIComponent(taskId)}/comment`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({text: val}),
      });
      const j = await r.json();
      if(j.ok){ input.value = ""; say("comment added — a retrying worker reads these", "ok"); }
      else say("comment failed: " + (j.error || "unknown"), "err");
    }catch(err){ say("comment failed: " + err.message, "err"); }
    btn.disabled = false;
  };
}

/* A task's run log is the live transcript of Hermes working. Polled rather
   than streamed: the log is a file on another box, and a 3s poll is far
   simpler than plumbing a second websocket for something read-only.

   The status header comes from /api/kanban/<id> — one card's worth of
   traffic. It used to refetch the ENTIRE board every 3s because the ssh CLI
   had no per-task read; the plugin API does. */
function openTaskLog(taskId){
  openWorkTabTurning("tasklog",taskId,taskId,(panel,tab)=>{
    panel.innerHTML = `<div class="kb-log-status">checking status…</div>
      <div class="kb-verify">
        <span class="kb-verify-label">VERIFY ON SNARF</span>
        <select class="kb-verify-check"><option value="">loading…</option></select>
        <button class="btn kb-verify-btn" disabled>Run</button>
        <label class="kb-verify-file"><input type="checkbox" checked> file result on the card</label>
        <button class="btn kb-land-btn" title="Verify, commit, push the card's branch, and open a PR if the check passes">Land ▸</button>
        <button class="btn kb-autoland-btn" title="Land, then wait for the PR's CI and merge on green -- no further click. Requires the card to have gone through review.">Land Autonomously ▸▸</button>
        <span class="kb-verify-status"></span>
      </div>
      <div class="kb-edit">
        <div class="kb-edit-head">
          <span>SPEC</span>
          <span class="kb-edit-note">the dispatch-target block is machinery — it is kept for you and not shown</span>
          <span class="kb-edit-spacer"></span>
          <span class="kb-edit-status"></span>
          <button class="kb-edit-toggle" type="button">edit ▾</button>
        </div>
        <div class="kb-edit-body" hidden>
          <textarea class="kb-edit-text" spellcheck="false" placeholder="loading…"></textarea>
          <div class="kb-edit-actions">
            <button class="btn kb-edit-save">Save spec</button>
            <button class="btn kb-edit-cancel">Cancel</button>
            <span class="kb-edit-sep">·</span>
            <input class="kb-comment-text" type="text" placeholder="add a comment for the next attempt…">
            <button class="btn kb-comment-add">Comment</button>
          </div>
        </div>
      </div>
      <pre class="kb-verify-out" hidden></pre>
      <pre class="kb-log">loading…</pre>`;
    panel.classList.add("tasklog-pane");
    const statusEl = panel.querySelector(".kb-log-status");
    const pre = panel.querySelector(".kb-log");
    kbWireVerify(panel, taskId);
    kbWireEdit(panel, taskId);
    // Delegated: the status line is rebuilt on every 3s poll, so a handler
    // bound to the button itself would be thrown away a moment later.
    statusEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".kb-log-reclaim");
      if(!btn) return;
      btn.disabled = true;
      btn.textContent = "Reclaiming…";
      fetch("/api/kanban/reclaim", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({task_id: btn.dataset.id}),
      }).then(r => r.json()).then(j => {
        if(!j.ok){ btn.disabled = false; btn.textContent = "Reclaim failed — retry"; return; }
        // The board is the other view of this same fact.
        refreshOpenKanbanBoards();
      }).catch(() => { btn.disabled = false; btn.textContent = "Reclaim failed — retry"; });
    });
    let stopped = false;
    const pullStatus = async () => {
      try{
        const r = await fetch(`/api/kanban/${encodeURIComponent(taskId)}`);
        const j = await r.json();
        const task = j.task;
        if(!task || !task.status){
          statusEl.innerHTML = `<span class="err">card not found on board</span>`;
          return;
        }
        const cls = KANBAN_STATUS_CLASS[task.status] ?? "";
        const msg = KANBAN_STATUS_MSG[task.status] ?? task.status;
        const runs = (j.runs || []).length;
        const attempts = runs > 1 ? ` · ${runs} runs` : "";
        // This pane is where you sit watching a run, so it is where you find
        // out it is wedged — and therefore where the way out of it belongs.
        // Having to close the log, go back to the board and find the card
        // again is the reason a stuck card just gets left alone.
        const mins = kbRunningMinutes(task);
        const elapsed = mins ? ` · ${mins < 60 ? mins+"m" : Math.floor(mins/60)+"h"+(mins%60)+"m"} elapsed` : "";
        const stuck = mins >= KB_STUCK_MINUTES
          ? ` <span class="warn">— no longer looks live</span>` : "";
        const reclaim = task.status === "running"
          ? ` <button class="btn kb-log-reclaim" data-id="${kanbanEsc(task.id)}"
               title="Kill this worker and reset the card to ready — the dispatcher starts a fresh run, costing another model run">Reclaim</button>` : "";
        statusEl.innerHTML = `<b class="${cls}">${task.status}${task.status==="running"?" ●":""}</b> — ${msg}${attempts}${elapsed}${stuck}${reclaim}`;
      }catch(err){ statusEl.innerHTML = `<span class="err">status unavailable: ${err.message}</span>`; }
    };
    const pullLog = async () => {
      if(stopped) return;
      try{
        const r = await fetch(`/api/kanban/${encodeURIComponent(taskId)}/log?lines=400`);
        const j = await r.json();
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
        pre.textContent = j.log || j.error || "(no run log yet — still in triage/queue; see status above)";
        if(atBottom) pre.scrollTop = pre.scrollHeight;
      }catch(err){ pre.textContent = "log unavailable: "+err.message; }
    };
    const pull = () => { pullStatus(); pullLog(); };
    pull();
    const iv = setInterval(pull, 3000);
    tab.onBeforeClose = () => { stopped = true; clearInterval(iv); };
  });
}

/* ============================ FINDINGS ==============================
   What a finished card produced, as opposed to what it did. The run log is a
   transcript; this is the result, and the two are not the same document.

   The 2026-09-02 swarm made the gap concrete. Its synthesizer signed off with
   "the actionable output is in synthesis.md in the workspace and posted as a
   structured comment on the swarm root blackboard" -- so the result lived in
   two places, neither of them the card you were looking at, and one of them
   (the workspace file) had already been deleted by the completion that made
   the card done.

   So the pane is ordered by durability, which is also the order worth reading
   in: summary, the structured facts the run recorded, the swarm blackboard,
   the card's comments, and last the files the run named -- each CHECKED, with
   a plain sentence when one is gone. A path printed without checking it is
   five minutes of chasing a file that is not there. */

const KB_OUT_MAX_DEPTH = 4;

/* Values in run metadata and blackboard entries are small JSON trees --
   decision lists, per-tool verdicts, a resource table. Rendered structurally
   rather than as one JSON blob, because this pane exists to be READ. Depth is
   capped and the tail falls back to <pre>, so a surprising payload degrades
   to something ugly-but-complete instead of an empty box. */
function kbOutValue(v, depth = 0){
  if(v === null || v === undefined) return `<span class="kb-out-nil">—</span>`;
  if(Array.isArray(v)){
    if(!v.length) return `<span class="kb-out-nil">none</span>`;
    return `<ul class="kb-out-list">${v.map(i =>
      `<li>${kbOutValue(i, depth + 1)}</li>`).join("")}</ul>`;
  }
  if(typeof v === "object"){
    if(depth >= KB_OUT_MAX_DEPTH){
      return `<pre class="kb-out-json">${kanbanEsc(JSON.stringify(v, null, 2))}</pre>`;
    }
    const rows = Object.entries(v).map(([k, val]) =>
      `<div class="kb-out-row"><span class="kb-out-key">${kanbanEsc(k)}</span>
         <div class="kb-out-val">${kbOutValue(val, depth + 1)}</div></div>`).join("");
    return `<div class="kb-out-obj">${rows}</div>`;
  }
  return kanbanEsc(String(v));
}

function kbOutSection(title, inner, sub){
  return `<div class="kb-out-sec"><div class="kb-out-head">${kanbanEsc(title)}
    ${sub ? `<span class="kb-out-sub">${kanbanEsc(sub)}</span>` : ""}</div>${inner}</div>`;
}

function kbOutRender(panel, j){
  const box = panel.querySelector(".kb-out-body");
  if(!j.ok){
    box.innerHTML = `<div class="kb-out-note err">${kanbanEsc(j.error || "unavailable")}</div>`;
    return;
  }
  const run = j.run;
  const parts = [];

  parts.push(`<div class="kb-out-title">${kanbanEsc(j.task.title || j.task.id)}</div>
    <div class="kb-out-meta">${kanbanEsc(j.task.status || "")} ·
      ${kanbanEsc(j.task.assignee || "—")}${run && run.outcome
        ? " · run " + kanbanEsc(run.outcome) : ""}</div>`);

  if(run && (run.summary || "").trim()){
    parts.push(kbOutSection("SUMMARY",
      `<div class="kb-out-text">${kanbanEsc(run.summary)}</div>`));
  }else{
    // Worth saying rather than rendering as an empty pane: a card can finish
    // without writing a handoff, and then there is genuinely nothing here.
    parts.push(kbOutSection("SUMMARY",
      `<div class="kb-out-note">This card's run wrote no summary. Anything it
        produced is in the sections below, or in its run log.</div>`));
  }

  const md = (run && run.metadata) || {};
  if(Object.keys(md).length){
    parts.push(kbOutSection("RECORDED FACTS", kbOutValue(md),
                            "structured metadata from the completing run"));
  }

  if(j.blackboard){
    const entries = j.blackboard.entries.map(e => {
      const body = e.data ? kbOutValue(e.data)
        : `<div class="kb-out-text">${kanbanEsc(e.text || "")}</div>`;
      return `<div class="kb-out-entry">
        <div class="kb-out-entry-head"><span class="kb-out-kind">${kanbanEsc(e.kind)}</span>
          <span class="kb-out-author">${kanbanEsc(e.author || "?")}</span></div>${body}</div>`;
    }).join("");
    parts.push(kbOutSection("SWARM BLACKBOARD", entries,
      `posted on root ${j.blackboard.root_id} — every worker's findings, the gate, the synthesis`));
  }

  (j.artifacts || []).forEach(a => {
    if(a.exists){
      parts.push(kbOutSection(a.path,
        `<pre class="kb-out-file">${kanbanEsc(a.content || "")}</pre>`,
        `${a.bytes} bytes on ${a.host}${a.truncated ? " · truncated" : ""}`));
    }else{
      parts.push(kbOutSection(a.path,
        `<div class="kb-out-note warn">${kanbanEsc(a.why || a.error || "unreadable")}</div>`,
        `named by the run · ${a.host}`));
    }
  });

  const comments = (j.comments || []).filter(c => c.body);
  if(comments.length){
    parts.push(kbOutSection("COMMENTS ON THIS CARD", comments.map(c =>
      `<div class="kb-out-entry"><div class="kb-out-entry-head">
         <span class="kb-out-author">${kanbanEsc(c.author || "?")}</span></div>
       <div class="kb-out-text">${kanbanEsc(c.body)}</div></div>`).join("")));
  }

  box.innerHTML = parts.join("");
}

function openTaskOutput(taskId){
  openWorkTabTurning("taskoutput", taskId, taskId + " ▸ findings", (panel) => {
    panel.classList.add("taskoutput-pane");
    panel.innerHTML = `
      <div class="kb-out-bar">
        <span class="kb-out-bar-title">FINDINGS</span>
        <span class="kb-out-bar-sub">what this card produced — the run log is the transcript, this is the result</span>
        <span class="kb-out-spacer"></span>
        <button class="btn kb-out-log">Run log ▸</button>
      </div>
      <div class="kb-out-body"><div class="kb-out-note">loading…</div></div>`;
    panel.querySelector(".kb-out-log").onclick = () => openTaskLog(taskId);
    // One shot, no poll: a done card's output does not move, and this pane is
    // only offered on done cards.
    fetch(`/api/kanban/${encodeURIComponent(taskId)}/output`)
      .then(r => r.json())
      .then(j => kbOutRender(panel, j))
      .catch(err => kbOutRender(panel, {ok: false, error: err.message}));
  });
}

document.querySelectorAll('[data-action="kanban"]').forEach(btn=>{
  btn.addEventListener("click", openKanbanBoard);
});
