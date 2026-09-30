# HANDOFF -> CT112 (looking-glass) — CODEBASE MAP polish

Written 2026-09-30 by claude-control (CT110). This work was done from CT110 on
Sam's explicit direction, but it is **your** project now — HUD edit + render is
one loop on this node, and ownership.yaml (`claude-control:124ec93`) now says so.
Please don't route further HUD work back through CT110/snarf.

## The unlock: you can SEE the HUD yourself — you don't need to hand off for eyeballs

This node has `scripts/screenshot-hud.py` (headless Chromium over DevTools: sets
the token, `--click`s into a view, dumps the console). That is the whole reason
this bounced between nodes — nobody on CT110/snarf could render it. You can:

```bash
# CODEBASE MAP, default (concentric) view:
scripts/screenshot-hud.py /tmp/map.png --click '[data-action="codebase-map"]' --wait 6
# grouped (compound / cose) view — item #3:
scripts/screenshot-hud.py /tmp/map-grouped.png \
  --click '[data-action="codebase-map"]' --click '.cbg-group' --wait 6
# then Read the PNG. Edit panel -> `systemctl restart looking-glass` -> re-shoot.
```

## What landed (branches HOLDING — local, not pushed, same as before)

- CT112 `hud-model-tuning`: `54c93fc` issue overlay · `be68dba` async dispatch ·
  `aa70fc0` cluster grouping (this branch).
- snarf `wire-tuned-v4flash-lookingglass`: `62761d9` "running" marker ·
  `4aef0b7` handover update.
- Full detail: snarf `/ssdpool/coder-engine/pipeline/HANDOVER-codebase-map.md`.

1. **Issue overlay (#1)** — panel maps open DARKHELIX issues (`/api/darkhelix-todo`)
   to nodes client-side; amber outline + `⚑N`, "issues only" toggle. 13/76 match.
2. **Async review dispatch (#2)** — `POST /api/review-file` takes `"async": true`;
   endpoint body lifted into `_run_review`, run as a background task; panel marks
   the node "reviewing" (cyan) and polls `/api/review-status`.
   `dispatch_review_task.py` writes a "running" marker at graph start.
3. **Cluster grouping (#3, first cut)** — opt-in "group by cluster" toggle:
   compound boxes + core `cose`. Default concentric view untouched.

## What I could NOT do from CT110 — please close these (they need your render / GPU)

- **Eyeball everything once.** Verify the amber issue outlines, the "reviewing"
  cyan state, and the grouped/cose layout actually look right. I verified them
  headless (cy 3.30.2: compound+cose runs, parents adopt children, node outline
  supported) but never SAW them.
- **Run one real async review end-to-end.** I verified the plumbing in isolation
  (400 path, async branch wired, `_mark_running` writes a valid record) but did
  NOT fire a real ~47-min review — it burns the GPU and files a kanban card, so I
  left that for a deliberate live run. Click RUN REVIEW and confirm: node goes
  cyan immediately, poll flips it to the outcome, a `--triage` card appears.
- **#3's aesthetic pass** — the ELK/fcose "metro/circuit" layout + collapsible
  clusters the original handover flagged as "needs a session that can see the
  render." The `.cbg-group` toggle + per-node `cluster` are the groundwork; swap
  the layout in behind that same toggle and iterate with screenshot-hud.py.

## One ask that is yours to write

Add a one-line pointer to `scripts/screenshot-hud.py` (with the CODEBASE MAP
invocation above) in this node's CLAUDE.md / HUD README. That is the missing
discoverability that let this get started on the wrong node in the first place —
and it belongs in your tree, not written by CT110.
