#!/usr/bin/env python3
"""Recompute potsherd's four headline numbers without potsherd.

Standard library only, no install, ~60 lines. Run it next to `potsherd audit`
and the numbers must match. If they ever do not, potsherd has the bug and this
script is right.

    python3 scripts/verify-audit.py
    python3 scripts/verify-audit.py --claude-dir ~/backup/.claude
    python3 scripts/verify-audit.py --json

Definitions, identical to the ones in packages/core/src/audit.ts:

  sessions ever started  distinct session ids seen in ANY of history.jsonl, the
                         transcripts on disk, or sessions-index.json
  still on disk          of those, the ones with a transcript file today
  deleted                ever - on disk
  prompts lost           lines in history.jsonl whose sessionId is deleted
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys


SIDECHAIN_DIR = "subagents"


def is_sidechain(path: str) -> bool:
    """True for a subagent transcript, at whatever depth it sits."""
    return SIDECHAIN_DIR in path.split(os.sep)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--claude-dir", default=os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
    ap.add_argument("--json", dest="as_json", action="store_true", help="print the numbers as JSON")
    args = ap.parse_args()

    root = os.path.expanduser(args.claude_dir)
    history_path = os.path.join(root, "history.jsonl")
    projects = os.path.join(root, "projects")

    # 1. every session id with a transcript still on disk.
    #
    # Subagent ("sidechain") transcripts are NOT sessions: they belong to the
    # session that spawned them, and counting one would inflate "still on disk"
    # and hide a deleted session. Two layouts have been observed —
    #   projects/<slug>/<session-uuid>/subagents/agent-*.jsonl
    #   projects/<slug>/subagents/agent-*.jsonl
    # — and the glob below (one level deep) matches neither. The filter is belt
    # and braces so that widening the glob can never quietly change the count.
    session_files = [
        f
        for f in glob.glob(os.path.join(projects, "*", "*.jsonl"))
        if not is_sidechain(f)
    ]
    on_disk = {os.path.basename(f)[: -len(".jsonl")] for f in session_files}
    sidechains = [
        f
        for f in glob.glob(os.path.join(projects, "*", "**", "*.jsonl"), recursive=True)
        if is_sidechain(f)
    ]

    # 2. every session id and prompt count in history.jsonl (streamed)
    prompts_by_session: dict[str, int] = {}
    history_lines = 0
    if os.path.exists(history_path):
        with open(history_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                history_lines += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                sid = rec.get("sessionId")
                if sid:
                    prompts_by_session[sid] = prompts_by_session.get(sid, 0) + 1

    # 3. every session id named by a surviving sessions-index.json
    indexed: set[str] = set()
    for p in glob.glob(os.path.join(projects, "*", "sessions-index.json")):
        try:
            with open(p, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        for entry in data.get("entries", []):
            sid = entry.get("sessionId")
            if sid and not entry.get("isSidechain"):
                indexed.add(sid)

    ever = on_disk | set(prompts_by_session) | indexed
    deleted = ever - on_disk
    prompts_lost = sum(prompts_by_session.get(sid, 0) for sid in deleted)
    prompts_surviving = sum(n for sid, n in prompts_by_session.items() if sid in on_disk)

    result = {
        "claudeDir": root,
        "sessionsEver": len(ever),
        "onDisk": len(on_disk),
        "deleted": len(deleted),
        "promptsLost": prompts_lost,
        "promptsSurviving": prompts_surviving,
        "historyLines": history_lines,
        "historySessions": len(prompts_by_session),
        "sidechainFiles": len(sidechains),
    }

    if args.as_json:
        print(json.dumps(result, indent=2))
        return 0

    print(f"verify-audit  {root}")
    print()
    print(f"  sessions ever started   {result['sessionsEver']:>7,}")
    print(f"  still on disk           {result['onDisk']:>7,}")
    print(f"  deleted                 {result['deleted']:>7,}")
    print(f"  prompts lost            {result['promptsLost']:>7,}")
    print()
    print("  these must equal `potsherd audit`. if they do not, potsherd is wrong.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
