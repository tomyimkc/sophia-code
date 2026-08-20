# Sophia Code

Open-edition terminal coding agent. Apache-2.0. **Not AGI.**

This repository is a generated slice of [sophia-agi](https://github.com/tomyimkc/sophia-agi):
the Ink TUI plus the coding kernel, without Conscience gating, effort/ultramode,
A2A, workflow/flow, or AGI-shaped planner surfaces.

`candidateOnly: true` · `canClaimAGI: false`

## Command-line install

Need **Git**, **Python 3.11+**, and **Node.js 20+** on PATH. Then clone and
install. After install, `sophia-lite` is the command.

| | macOS | Linux | Windows |
|---|---|---|---|
| Install | `./tools/install_sophia_lite.sh` | `./tools/install_sophia_lite.sh` | `py -3 tools\install_sophia_lite.py` |
| Run TUI | `sophia-lite` | `sophia-lite` | `sophia-lite` |
| One-shot CLI | `sophia-lite -p "…" --mock` | same | same (`-p` is the prompt) |

### macOS

```bash
# Once, if missing:  brew install git python@3.12 node
git clone https://github.com/tomyimkc/sophia-code.git
cd sophia-code
./tools/install_sophia_lite.sh
export PATH="$HOME/.local/bin:$PATH"
sophia-lite
sophia-lite -p "summarize this repo" --mock
```

From the clone without putting it on PATH: `./bin/sophia-lite`

### Linux

```bash
# Debian/Ubuntu example, if missing:
#   sudo apt install -y git python3 python3-pip nodejs npm
git clone https://github.com/tomyimkc/sophia-code.git
cd sophia-code
./tools/install_sophia_lite.sh
export PATH="$HOME/.local/bin:$PATH"
sophia-lite
sophia-lite -p "summarize this repo" --mock
```

From the clone without putting it on PATH: `./bin/sophia-lite`

### Windows

cmd or PowerShell. Python 3.11+ and Node.js 20+ on PATH
(`winget install Git.Git Python.Python.3.12 OpenJS.NodeJS.LTS`, then a **new**
terminal).

```bat
git clone https://github.com/tomyimkc/sophia-code.git
cd sophia-code
py -3 tools\install_sophia_lite.py
sophia-lite
sophia-lite -p "summarize this repo" --mock
```

From the clone without putting it on PATH:

```bat
bin\sophia-lite.cmd
bin\sophia-lite.cmd -p "summarize this repo" --mock
```

If `sophia-lite` is not found after install, add `%USERPROFILE%\.local\bin` to
PATH and open a new terminal.

## Commands

| Command | What it does |
|---|---|
| `sophia-lite` | Open-edition Ink TUI |
| `sophia-lite -p "your goal"` | Python CLI (`-p` is `--prompt`) |
| `sophia-lite --json --readonly --no-tools --mock -p "reply with pong"` | Offline CLI smoke |
| `/login grok` (inside the TUI) | Official `grok login --oauth` browser sign-in |

TUI permission is `--permission`. CLI `-p` is the prompt. Tokens stay in
`~/.grok/auth.json`. This tree does not implement xAI OAuth.

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

`SOPHIA_EDITION=oss` is baked in. Do not set it to `full` in this tree; the
full-only modules are not shipped.

## Upgrade path

Do not fork-and-edit this tree as a second product. Changes land in sophia-agi
with an `editions` tag, then `python tools/export_sophia_code.py --out <dir>`
regenerates this repository.
