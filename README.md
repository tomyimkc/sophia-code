# Sophia Code

Open-edition terminal coding agent. Apache-2.0. **Not AGI.**

This repository is a generated slice of [sophia-agi](https://github.com/tomyimkc/sophia-agi):
the Ink TUI plus the coding kernel, without Conscience gating, effort/ultramode,
A2A, workflow/flow, or AGI-shaped planner surfaces.

`candidateOnly: true` · `canClaimAGI: false`

## Install

Linux / macOS:

```bash
git clone https://github.com/tomyimkc/sophia-code.git
cd sophia-code
./tools/install_sophia_lite.sh   # npm ci + build, then links ~/.local/bin/sophia-lite
export PATH="$HOME/.local/bin:$PATH"
sophia-lite                      # TUI
sophia-lite -p "summarize this repo" --mock   # Python CLI (`-p` is --prompt)
```

Windows (cmd or PowerShell) — Python 3.11+ and Node.js 20+ on PATH:

```bat
git clone https://github.com/tomyimkc/sophia-code.git
cd sophia-code
py -3 tools\install_sophia_lite.py
sophia-lite
sophia-lite -p "summarize this repo" --mock
```

Or from the clone without installing to PATH:

```bat
bin\sophia-lite.cmd --mock
py -3 -m sophia.cli lite --json --readonly --no-tools --mock -p "reply with pong"
```

## What you get

- Chat, streaming, slash commands, sessions
- Tools: read / write / edit / bash (permission-gated)
- `/model`, `/permissions`, `/plan`, `/compact`, `/resume`, `/login`, `/setup`
- Ink TUI **and** Python CLI (`sophia-lite -p` / `--json`)
- MCP and skills
- Bring your own model keys, or a Grok subscription via official `grok login`

## What this edition does not include

Conscience delivery gate, `/effort` / ultramode, A2A, dynamic workflows,
GoT/Flow Studio, and the AGI-shaped planner. Those stay in the full Sophia TUI.

## Grok subscription

On a new device pick **Grok** at first-run (or `/setup` / `/model grok`), then
`/login grok`. That launches the official `grok login --oauth` browser sign-in.
Tokens stay in `~/.grok/auth.json`. This tree does not implement xAI OAuth.

TUI permission is `--permission`. CLI `-p` is the prompt.

## Run from the clone

```bash
cd apps/sophia-tui && npm ci && npm run build && cd ../..
./bin/sophia-lite --mock
./bin/sophia lite
./bin/sophia-lite -p "summarize this repo" --mock
```

Windows:

```bat
cd apps\sophia-tui && npm ci && npm run build && cd ..\..
bin\sophia-lite.cmd --mock
bin\sophia.cmd lite -p "summarize this repo" --mock
```

`SOPHIA_EDITION=oss` is baked in. Do not set it to `full` in this tree; the
full-only modules are not shipped.

## Upgrade path

Do not fork-and-edit this tree as a second product. Changes land in sophia-agi
with an `editions` tag, then `python tools/export_sophia_code.py --out <dir>`
regenerates this repository.
