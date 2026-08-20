# Sophia Code

Open-edition terminal coding agent. Apache-2.0. **Not AGI.**

This repository is a generated slice of [sophia-agi](https://github.com/tomyimkc/sophia-agi):
the Ink TUI plus the coding kernel, without Conscience gating, effort/ultramode,
A2A, workflow/flow, or AGI-shaped planner surfaces.

`candidateOnly: true` · `canClaimAGI: false`

## What you get

- Chat, streaming, slash commands, sessions
- Tools: read / write / edit / bash (permission-gated)
- `/model`, `/permissions`, `/plan`, `/compact`, `/resume`
- MCP and skills
- Bring your own model keys

## What this edition does not include

Conscience delivery gate, `/effort` / ultramode, A2A, dynamic workflows,
GoT/Flow Studio, and the AGI-shaped planner. Those stay in the full Sophia TUI.

## Run

```bash
# kernel on PYTHONPATH (repo root)
python3 -m agent.code_bridge   # used automatically by the TUI

cd apps/sophia-tui
npm ci
npm run build
node dist/index.js --mock
```

Or from the repo root after a TUI build:

```bash
./bin/sophia --mock
```

`SOPHIA_EDITION=oss` is baked in. Do not set it to `full` in this tree; the
full-only modules are not shipped.

## Upgrade path

Do not fork-and-edit this tree as a second product. Changes land in sophia-agi
with an `editions` tag, then `python tools/export_sophia_code.py --out <dir>`
regenerates this repository.
