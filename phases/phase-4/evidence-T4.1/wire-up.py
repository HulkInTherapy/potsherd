"""Apply (or revert) the two RESERVED registration blocks, locally.

`packages/core/src/index.ts` and `packages/cli/src/index.ts` are reserved: the
orchestrator adds every worker's exports in one integration commit, so T4.1's
branch does not carry them. But `ask` cannot be *run* without them, and a verb
whose numbers were never measured is not a verb.

So the blocks live in `registration-T4.1.txt`, this script pastes them in from
that file — the same text the integrator will paste, never a second copy that
could drift — and `--revert` takes them out again. Every measurement in this
directory was taken with them applied.

    python3 phases/phase-4/evidence-T4.1/wire-up.py            # apply
    pnpm build
    sh phases/phase-4/evidence-T4.1/run.sh …                   # measure
    python3 phases/phase-4/evidence-T4.1/wire-up.py --revert
    pnpm build

Run from the repo root. Idempotent in both directions.
"""
import io
import sys

REG = 'phases/phase-4/registration-T4.1.txt'
CORE = 'packages/core/src/index.ts'
CLI = 'packages/cli/src/index.ts'

CORE_MARK = '// ---------------------------------------------------------------- phase 4\n// L7 — `ask`'
CLI_IMPORT_OLD = "import { Theme } from '@potsherd/core';"
CLI_IMPORT_NEW = "import { Theme, ASK_K, ASK_MAX_USD, ASK_CONCURRENCY } from '@potsherd/core';"
CLI_CMD_OLD = "import { runLink } from './commands/link.js';"
CLI_CMD_NEW = CLI_CMD_OLD + "\nimport { runAsk } from './commands/ask.js';"
CLI_ANCHOR = '  const ls = addFilters(\n'


def blocks():
    reg = io.open(REG, encoding='utf-8').read()
    core = reg[reg.index(CORE_MARK):reg.index('  NOTE for the integrator:')].rstrip() + '\n'
    cli = reg[reg.index('  const ask = addFilters('):reg.index('3. `MODEL_CALL_VERBS`')]
    cli = cli.rstrip().rstrip('=').rstrip() + '\n\n'
    return core, cli


def apply_():
    core_block, cli_block = blocks()

    s = io.open(CORE, encoding='utf-8').read()
    if CORE_MARK not in s:
        io.open(CORE, 'w', encoding='utf-8').write(s.rstrip() + '\n\n' + core_block)

    c = io.open(CLI, encoding='utf-8').read()
    if 'runAsk' not in c:
        c = c.replace(CLI_IMPORT_OLD, CLI_IMPORT_NEW)
        c = c.replace(CLI_CMD_OLD, CLI_CMD_NEW)
        assert CLI_ANCHOR in c
        c = c.replace(CLI_ANCHOR, cli_block + CLI_ANCHOR, 1)
        io.open(CLI, 'w', encoding='utf-8').write(c)
    print('applied — now run: pnpm build')


def revert():
    s = io.open(CORE, encoding='utf-8').read()
    if CORE_MARK in s:
        io.open(CORE, 'w', encoding='utf-8').write(s[:s.index(CORE_MARK)].rstrip() + '\n')

    c = io.open(CLI, encoding='utf-8').read()
    if 'runAsk' in c:
        c = c.replace(CLI_IMPORT_NEW, CLI_IMPORT_OLD)
        c = c.replace(CLI_CMD_NEW, CLI_CMD_OLD)
        start = c.index('  const ask = addFilters(')
        c = c[:start] + c[c.index(CLI_ANCHOR, start):]
        io.open(CLI, 'w', encoding='utf-8').write(c)
    print('reverted — now run: pnpm build')


(revert if '--revert' in sys.argv else apply_)()
