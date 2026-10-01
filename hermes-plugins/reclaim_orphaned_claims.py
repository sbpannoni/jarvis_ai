#!/usr/bin/env python3
"""Reclaim orphaned kanban claims.

A card in `running` whose worker died without completing/blocking keeps its claim
until `claim_expires`, then just sits -- this Hermes install has no reclaim cron
(`hermes cron list` is empty), so nothing frees it and it wedges the single
in-progress slot forever (the t_c60014ec hang, 2026-09-30). This runs from a
systemd timer and reclaims any `running` card whose claim expired more than a
grace period ago; `hermes kanban reclaim` returns it to `ready` for the
dispatcher to retry.

Read-only on the DB (the board is shared SQLite; writes go through the CLI, which
takes the proper lock). Grace avoids racing a worker that is about to renew.
"""
import sqlite3
import subprocess
import sys
import time

DB = "/root/.hermes/kanban.db"
GRACE_S = 90          # only reclaim once the claim has been expired this long
HB_STALE_S = 300      # ...and the last heartbeat is at least this old (belt + braces)


def main() -> int:
    now = time.time()
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, title, created_by, claim_expires, last_heartbeat_at "
            "FROM tasks WHERE status='running'"
        ).fetchall()
    finally:
        con.close()

    acted = 0
    for r in rows:
        exp = r["claim_expires"] or 0
        hb = r["last_heartbeat_at"] or 0
        claim_expired = exp and exp < (now - GRACE_S)
        hb_stale = (not hb) or hb < (now - HB_STALE_S)
        if not (claim_expired and hb_stale):
            continue
        # Looking-glass sweep trackers are not real work -- an orphaned one is
        # archived (cleaned up), never reclaimed, so it can't be dispatched into a
        # junk worker. Everything else is a genuine orphaned claim: reclaim it back
        # to ready for the dispatcher to retry.
        is_tracker = (r["created_by"] == "looking-glass"
                      and (r["title"] or "").startswith("[Sweep]"))
        verb = "archive" if is_tracker else "reclaim"
        res = subprocess.run(["hermes", "kanban", verb, r["id"]],
                             capture_output=True, text=True)
        ok = res.returncode == 0
        print(f"{verb} {'ok' if ok else 'FAILED'} {r['id']} "
              f"(claim expired {int(now - exp)}s ago): "
              f"{(res.stdout or res.stderr).strip()[:200]}", flush=True)
        acted += int(ok)
    if acted:
        print(f"acted on {acted} orphaned card(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
