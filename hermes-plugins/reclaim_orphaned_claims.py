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
            "SELECT id, claim_expires, last_heartbeat_at FROM tasks WHERE status='running'"
        ).fetchall()
    finally:
        con.close()

    reclaimed = 0
    for r in rows:
        exp = r["claim_expires"] or 0
        hb = r["last_heartbeat_at"] or 0
        claim_expired = exp and exp < (now - GRACE_S)
        hb_stale = (not hb) or hb < (now - HB_STALE_S)
        if claim_expired and hb_stale:
            res = subprocess.run(["hermes", "kanban", "reclaim", r["id"]],
                                 capture_output=True, text=True)
            ok = res.returncode == 0
            print(f"{'reclaimed' if ok else 'reclaim FAILED for'} {r['id']} "
                  f"(claim expired {int(now - exp)}s ago): "
                  f"{(res.stdout or res.stderr).strip()[:200]}", flush=True)
            reclaimed += int(ok)
    if reclaimed:
        print(f"reclaimed {reclaimed} orphaned card(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
