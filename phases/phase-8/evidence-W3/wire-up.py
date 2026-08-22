#!/usr/bin/env python3
"""Apply (or revert) the two reserved-barrel edits in registration-W3.txt.

`registration-W3.txt` is the authority; this script exists so the measurements
in this directory can be reproduced without pasting by hand. The self-contained
blocks (the CLI import, the two commands, the tour line) are read out of that
file so there is no second copy of them here. Only
`packages/cli/src/index.ts` is touched — the core barrel needs no change.

    python3 phases/phase-8/evidence-W3/wire-up.py            # apply
    python3 phases/phase-8/evidence-W3/wire-up.py --revert   # take them out
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REG = ROOT / "phases" / "phase-8" / "registration-W3.txt"
CLI = ROOT / "packages" / "cli" / "src" / "index.ts"
LLM = ROOT / "packages" / "core" / "src" / "llm.ts"

ALL_OPTION = "      .option('--all', 'include the projects  potsherd ignore  hides'),\n"


def block(name: str) -> str:
    m = re.search(r">>>BEGIN %s\n(.*?)<<<END %s" % (name, name), REG.read_text(), re.S)
    if not m:
        raise SystemExit("no block %r in %s" % (name, REG))
    return m.group(1)


def pairs():
    core_import = block("cli-import")
    return [
        # (file, before, after)
        (
            CLI,
            "import { runPin } from './commands/pin.js';\n",
            "import { runPin } from './commands/pin.js';\n" + core_import,
        ),
        (
            CLI,
            "          'print  claude --resume <id>  # <title>  lines to paste into your shell',\n        ),\n",
            "          'print  claude --resume <id>  # <title>  lines to paste into your shell',\n        )\n" + ALL_OPTION,
        ),
        (
            CLI,
            "      .option('--with <tools>', 'also search other memory tools: claude-mem, agentmemory, notes'),\n",
            "      .option('--with <tools>', 'also search other memory tools: claude-mem, agentmemory, notes')\n" + ALL_OPTION,
        ),
        (
            CLI,
            "      .option('--no-fresh', 'skip the per-file staleness check'),\n",
            "      .option('--no-fresh', 'skip the per-file staleness check')\n" + ALL_OPTION,
        ),
        (
            CLI,
            "    await run(() => runLs({ ...o, ...filterFlags(opts), resumeMenu: Boolean(opts['resumeMenu']) }), o);\n",
            "    await run(\n      () => runLs({ ...o, ...filterFlags(opts), resumeMenu: Boolean(opts['resumeMenu']), all: Boolean(opts['all']) }),\n      o,\n    );\n",
        ),
        (
            CLI,
            "          explain: Boolean(opts['explain']),\n",
            "          explain: Boolean(opts['explain']),\n          all: Boolean(opts['all']),\n",
        ),
        (
            CLI,
            "    await run(() => runStats({ ...o, fresh: opts['fresh'] !== false }), o);\n",
            "    await run(() => runStats({ ...o, fresh: opts['fresh'] !== false, all: Boolean(opts['all']) }), o);\n",
        ),
        (
            CLI,
            "  [['card', 'tag', 'pin', 'unpin', 'link', 'guard'], 'what you add to it'],\n",
            "  [['card', 'tag', 'pin', 'unpin', 'link', 'guard'], 'what you add to it'],\n" + block("cli-tour"),
        ),
        (
            LLM,
            "  'stack',\n  'doctor',\n",
            "  'stack',\n" + block("llm-offline-verbs") + "  'doctor',\n",
        ),
        (
            CLI,
            "  const link = addGlobals(\n",
            block("cli-command") + "\n  const link = addGlobals(\n",
        ),
    ]


def move(forward: bool) -> None:
    for path, before, after in pairs() if forward else reversed(pairs()):
        src = path.read_text()
        want, have = (before, after) if forward else (after, before)
        if have in src and want not in src:
            continue  # already in the target state
        if want == "":
            src = src.rstrip("\n") + "\n" + have if forward else src.replace(have, "", 1)
        else:
            if src.count(want) != 1:
                raise SystemExit("anchor %r appears %d times in %s" % (want[:56], src.count(want), path))
            src = src.replace(want, have, 1)
        path.write_text(src)
    print("wired up" if forward else "reverted")


if __name__ == "__main__":
    move("--revert" not in sys.argv)
