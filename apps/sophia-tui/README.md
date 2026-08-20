# Sophia Code TUI

Sophia-native terminal workspace for verifier-gated coding and research, built
with React + [Ink](https://github.com/vadimdemedes/ink).

- Talks to the existing Python kernel via `python -m agent.code_bridge` (same protocol as macOS/web).
- Sophia operating-contract enforcement, OKF logs, and multi-backend routing
  (`zai` / `codex` / `codex-api` / …) live in the kernel.
- A truthful slash/product catalog (`agent/slash_catalog.py` →
  `src/lib/slash-commands.json`); catalog presence does not imply execution.
- Every command exports an argument schema, category, badges, and separate TUI
  and terminal execution/handler metadata.

`candidateOnly: true` · `canClaimAGI: false`

Open-edition (public Sophia Code CLI) uses `SOPHIA_EDITION=oss` to hide
Conscience, effort, A2A, workflow/flow, and AGI-shaped commands. The same TUI
source ships both editions. See [Sophia-Code-Open-Edition.md](../../docs/09-Agent/Sophia-Code-Open-Edition.md).

## Install & run

```bash
# from repo root
cd apps/sophia-tui
npm ci
npm run build

# interactive
npm start
# development-only source runner (requires dependencies; no network fallback)
npm run dev -- --mock

# from anywhere after tools/install_sophia_cli.sh
sophia              # uses the built TUI when present; otherwise Python REPL
SOPHIA_UI=tui sophia # require the built TUI (fails with a diagnostic if absent)
SOPHIA_DEV=1 SOPHIA_UI=tui sophia # explicit local source mode
sophia-tui --mock
sophia-tui --model zai
sophia lite                 # open-edition TUI (also: sophia-lite)
sophia lite -p "summarize this repo" --mock   # open-edition Python CLI
```

On a new device, first-run or `/setup` picks the LLM. `/login grok` opens the
official Grok CLI browser sign-in so a Grok subscription can drive the session.

The advisory TUI workflow performs a clean `npm ci`, typecheck, unit-test run,
and ordinary build on `ubuntu-latest`, `macos-latest`, and `windows-latest`.
Release assembly remains a separate release-workflow responsibility.

## Plugin platform v1 beta

The source beta supports strict declarative skill, agent, workflow, and profile
packs plus explicitly approved supervised runtime adapters. Plugins propose or
narrow behavior; Sophia retains permission, execution, verification, receipt,
and delivery authority.

Use the isolated launcher from the repository root:

```bash
python3 tools/check_sophia_plugin_beta.py
tools/run_sophia_plugin_beta.sh --workspace "$PWD" --mock
```

Executable plugins are blocked by default. To test the bundled DeepSeek Harness
adapter, relaunch with `--allow-executable-plugins`, inspect it with
`/plugin permissions deepseek-harness`, and then explicitly approve it. The
adapter requests read-only operation and quarantines output, but it is not an
OS-level sandbox.

The DSH compatibility surface distinguishes local paths from configured or
cached registry references, but all discovery remains no-network. An explicitly
approved install may fetch only an immutable exact npm registry release. Sophia
reads bounded registry metadata and streams the same-origin, integrity-pinned
tarball into private staging itself; it does not invoke npm, accept Git/GitHub
specs, install dependencies, or run package lifecycle/build scripts. Before
installation, the staged package inventory and detached Ed25519 signature must
verify against operator-owned publisher trust and revocation state. Unsigned,
tampered, revoked, or build-dependent packages fail closed or remain
quarantined.

```text
/plugin compat list
/plugin compat discover <source>
/plugin compat install <source> [--approve]
/plugin compat uninstall <id>
/plugin compat rollback <id>
/plugin compat transactions
/plugin compat inspect <id>
/plugin compat test <id>
/plugin compat health [<id>]
/plugin compat tools <id>
/plugin compat call <plugin>/<tool> [JSON]
/plugin lock export <path>
/plugin lock import <path>
```

Portable lock export/import preserves signed archive identities for
reproducibility but never imports enablement or execution authority. DSH
install/update/rollback/uninstall operations and their compatibility lock are
serialized and journaled so a pending half-commit is recovered before reads.

The governed offline catalog is a separate passive metadata surface. It loads
a locally supplied signed catalog/trust store and never installs or executes a
catalog entry:

```text
/plugin catalog status
/plugin catalog search [query] [--contribution <kind>] [--capability <name>] [--protocol <name>] [--host-protocol <name>] [--platform <os>] [--architecture <arch>] [--eligible-only]
/plugin catalog inspect <plugin-id> [--host-protocol <name>] [--platform <os>] [--architecture <arch>]
/plugin catalog select <plugin-id> [--version <semver>] [--protocol <name>] [--host-protocol <name>] [--platform <os>] [--architecture <arch>] [--allow-stale] [--allow-prerelease]
```

Catalog selection returns only a digest-pinned candidate reference. It does
not approve compatibility installation, native plugin permissions, enablement,
safe-mode changes, or execution, and the DSH installer does not yet bind a
selected catalog receipt. Transparency-backed online freshness and revocation,
public marketplace publication/review/operations, hostile-package validation,
and broad ecosystem verification remain pending.

For an executable compatibility plugin, use the explicit sequence:

```text
/plugin compat discover <local-path-or-registry-reference>
/plugin compat inspect <compatibility-id>
/plugin compat install <source> --approve
/plugin permissions deepseek-harness-compat
/plugin enable deepseek-harness-compat --approve
/plugin safe-mode off
/plugin compat test <compatibility-id>
/plugin compat health <compatibility-id>
```

Return to the closed boundary with `/plugin safe-mode on` and, when no longer
needed, `/plugin disable deepseek-harness-compat`. Install approval and runtime
permission approval are separate; safe mode off does neither.

RPC v2 compatibility exposes only bounded, catalog-advertised
catalog/tool/workflow/job/artifact methods with job-scoped cancellation and
secret-free events. The old `dsh --profile headless` adapter remains an
explicit single-flight fallback. Both lanes run as the current OS user and are
not an OS sandbox. The separate generic plugin supervisor can conditionally use
macOS Seatbelt or Linux bubblewrap when a manifest requests a supported policy;
partial or unavailable providers remain visibly unsandboxed, and Windows
isolation and production hardening remain pending.

This is compatibility infrastructure, not evidence that every public
plugin/topic repository is compatible. External-plugin conformance remains
pending; the source beta is `candidateOnly: true` and `canClaimAGI: false`.

See `docs/09-Agent/Sophia-Plugin-Platform-Beta.md` for the ABI, trust model,
Cordis/MCP/WASI comparison, beta acceptance gate, scale plan, and rollback.
See `docs/09-Agent/Sophia-DSH-Plugin-Compatibility.md` for discovery,
installation, statuses, RPC v2, permissions, and fallback details.

## Product defaults and first run

CLI flags, layered config, persisted local state, and live engine detection are
the source of truth. The TUI consumes the bridge's runtime profile and detected
engines instead of assuming one gateway exists.

| Profile | Model | Authority | Dispatch | Image generation |
|---------|-------|-----------|----------|------------------|
| **This Mac** | `omlx` | `full-authority` (runtime permission `auto`) | `workflow` | `Grok CLI` |
| **Public install** | detect installed engines, then ask | user must choose | ask on first use | disabled until configured |

Both profiles remain configurable and preserve `canClaimAGI:false`. Loopback
gateways (`:8788`, `:8789`, `:8000`, Ollama, and similar) are optional external
dependencies unless selected. Direct saved API credentials are preferred, and
cross-provider fallback requires confirmation.

### Model groups and TeamoRouter Claude

`/model` shows collapsed provider/runtime families instead of one flat list:
Ollama, vLLM, MLX/oMLX, local loopback gateways, Claude gateways, cloud APIs,
CLI backends, and other offline options. Use Up/Down to select a family and
Enter to expand or collapse it; model values and provider routing are unchanged.

The `teamorouter` option uses TeamoRouter's native Anthropic endpoint at
`https://api.teamorouter.com` with `claude-opus-5`. It reads only
`TEAMOROUTER_API_KEY` from the runtime environment; credentials are never read
from TUI config, rendered in the picker, or included in support bundles. Supply
the variable through a trusted local secret manager before launching Sophia.
Any key pasted into chat or a transcript should be revoked and replaced.

With `teamorouter` selected, ultramode keeps Opus 5 as the coordinator and final
synthesizer. When the deterministic swarm router decides a task warrants a
team, worker lanes use `claude-sonnet-5`; the `team_start` row names that worker
model. Easy tasks remain solo, and explicit `/agents` controls continue to win.

The `vip.aipro.love` gateway has exactly two `/model` choices:

| Choice | Coordinator | Ultramode/subagents | Credential source |
|--------|-------------|---------------------|-------------------|
| `aipro` | `claude-opus-5` | `claude-sonnet-5` | `SOPHIA_AIPRO_KEY` |
| `aipro-2` | `claude-opus-5` | `claude-sonnet-5` | `SOPHIA_AIPRO_KEY_2` |

Both choices reject endpoint overrides and never borrow a native Anthropic key.
Legacy aipro aliases are no longer selectable or valid provider presets; a
previously saved alias is migrated once to the matching option during startup.
Set only the named environment variable through a trusted local secret manager.
Never put a credential value in `config.toml`, repository files, support bundles,
or chat.

## Confirmed local recovery after a primary refusal

Transport fallback handles provider errors. Semantic recovery handles a
different case: the selected cloud model returned `ok=true` but only supplied a
non-substantive policy refusal. It is off by default and never chooses an
"uncensored" model for a public install.

```text
/fallback-model status
/fallback-model ollama:qwen3:30b-a3b
/fallback-model return-main on
/fallback-model off
```

When configured, Sophia conservatively detects an explicit policy/safety
refusal, verifies that the configured target resolves to a local/self-hosted
endpoint, and asks before crossing cloud → local authority. The local run uses
the same workspace and tool-permission policy, with transport fallbacks
disabled. Its final output uses the same operator-selected Conscience policy as
the primary run.

## Optional final-answer Conscience / provenance policy

Sophia Code defaults to **off** so final-text provenance evaluation cannot delay
or replace ordinary task delivery. The operator can opt into evaluation or
enforcement at launch or in the TUI:

```bash
sophia --conscience off           # skip final-text gate evaluation (default)
sophia --conscience report        # evaluate and display, never withhold
sophia --conscience floor         # enforce only hard prohibitions
sophia --conscience strict        # enforce hard prohibitions and uncertainty holds
```

```text
/conscience status
/conscience off
/conscience report
/conscience floor
/conscience strict
```

`/provenance` is an alias for `/conscience`. These modes affect final-text
delivery only. They do not widen native tool permissions, approve shell or
network access, change `candidateOnly:true`, or change `canClaimAGI:false`.
External executable plugin/Prime runtimes retain their quarantine delivery floor
because disabling a native answer policy must not weaken an external authority
boundary.

With `return-main on` (the default), a local result accepted by the selected
final-answer policy is sent back to a fresh instance of the selected primary as
**untrusted candidate data**. The
primary is told to verify claims, continue the task, and not repeat successful
mutating tool steps. If it refuses again, Sophia does not loop: it retains the
safe local result and reports that the primary continuation declined. A held or
failed local result is never sent back to the primary.

## Provider-visible thinking and final-output speed

Choose how much provider-published thinking the TUI shows at launch or during
the session:

```bash
sophia-tui --model grok --thinking summary
```

```text
/thinking hidden
/thinking summary   # default; first 240 characters
/thinking stream    # up to 800 characters
/thinking full      # up to 4000 characters
```

These controls apply only to reasoning summaries or thinking events that the
provider exposes on a user-visible response surface. Grok CLI `thought`
records from its `streaming-json` protocol can grow one bounded thinking row;
completed provider-reported reasoning uses the same bounds. Unlabelled capture,
private/hidden chain-of-thought, and raw prompt/tool protocol records are not
used as reasoning rows. Provider-visible text can still mention context you
supplied, so use `hidden` for sensitive sessions. `full` therefore means the
fullest eligible provider-visible payload within the display bound, not access
to hidden chain-of-thought.

Assistant token events remain buffered behind the kernel's StreamFloorGuard and
final delivery gate; the authoritative `result` remains the only terminal
answer. Completed assistant transcript rows—including accepted results and
mid-loop prose—paint when they arrive instead of replaying through the old
15–25-token/s Matrix reveal. Provider-visible thinking updates are coalesced to
protect Ink from excessive repainting, but they are not replayed at an invented
token rate. The displayed `tok/s` value remains backend/kernel telemetry; UI
paint cadence does not recalculate or inflate it.

## Mouse and text selection

Application mouse controls are enabled on an interactive TTY so wheel events do
not get misread as prompt-history arrows. With mouse capture on, plain
drag-select is suppressed; use **Shift-drag** for native selection. Use
**Page Up/Page Down**, **Ctrl+U/Ctrl+D**, or **Shift+Up/Down** to navigate
Sophia's internal chat history.

```bash
sophia --no-mouse         # restore plain drag-select; wheel may degrade to arrows
SOPHIA_MOUSE=0 sophia     # same through the public launcher
```

In application mouse mode, use **Shift-drag** for terminal selection when your
terminal supports the standard override. Mouse reports are decoded as control
input and are never inserted into the prompt.

### Interactive Goal / Agents / To-do / AGI / Flow panel

The persistent right panel remains a compact overview. Click **Goal**,
**Agents**, **To-do**, **AGI**, or the **Flow** card fixed at the bottom to open
that section's full detail view in the main pane. The expanded view keeps the
compact panel visible, preserves the full Goal and To-do text, and shows
observable agent task, tool/lifecycle, output-preview, and final-report
receipts. It does not expose hidden model reasoning.

The Goal card is harness-owned after a run starts. The original operator prompt
is retained separately for provenance, while `goal_update` receipts let Main
revise the current objective as evidence, blockers, or workflow stages change.
The compact card shows the latest revision and honest ETA state; the expanded
Goal view shows the revision source, reason, timestamp, stage association, and
bounded revision history. ETA stays at **estimating** until the kernel supplies
a full-run estimate. Worker-stage timing remains labelled in workflow status
and never replaces the session ETA. Expired estimates return to recalibrating
instead of sticking at zero; provider waits can refresh them from successful
comparable run history. Only `run_finished` marks the session complete.

Workflow progress distinguishes the model's revisable planned stage count from
the operator's safety limit. For example, `stage 1/6` means Main currently plans
six stages; it does not mean the six-stage maximum must be consumed. Main may
revise that plan as work develops, but the displayed total never falls below a
stage already reached.

Agent rows use terminal-safe status bots instead of a single static glyph.
Idle, queued, working, waiting, succeeded, failed, and cancelled states have
different colors and faces; active states animate without blocking the event
loop. Reduced-motion and screen-reader modes keep the same status labels while
suppressing decorative animation. Clicking an agent still opens only
observable task, tool, lifecycle, and report receipts—not hidden reasoning.

The live Flow card preserves accepted bridge events in one canonical session
graph, then renders a lower-cardinality semantic projection. Its compact card
is a small block-and-arrow overview. Opening Flow replaces the left transcript
pane with a larger Draw.io-style diagram: labeled rectangular blocks,
orthogonal connectors, directional arrowheads, parallel agent lanes,
loop/back-edge routing, status colors, and a selected-block outline. The right
panel becomes the inspector for the selected block and lists the safe,
observable events folded into that block.

The default overview shows major flow only. A dynamic Workflow is one live
capsule rather than one node per worker update; the capsule streams its current
stage, barrier/report progress, worker counts, and latest bounded operational
activity. AGI workflow runs keep one major node per AGI node, and each AGI node
can act as a portal into its nested workflow. Enter a capsule to move through
the hierarchy **overview → stages → workers**. Minor model, provider, tool, and
progress events remain preserved for the inspector but do not participate in
graph layout, minimap navigation, or the default Draw.io export. Approval,
failure/block/cancellation, receipt, synthesis, result, and final-output
milestones remain visible as major nodes.

Each ordinary run is projected as one merged harness row with three fixed
causal roles: **Main Agent → Workflow → Output**. Main Agent owns the request
and dispatches Workflow; Output is the terminal product emitted after Workflow.
Late status or telemetry receipts remain visible as provenance, but never move
Output to the left of Workflow or steal live focus from the active Workflow.

Compound workflow runs can group one to three child workflows inside one
rectangular process frame. The process frame—not an individual child—is the
external dependency endpoint. Parallel frames use separate lanes and converge
through a visible all-of join; only after every required frame has completed
successfully may the next serial frame start. Each handoff uses an immutable
output reference and digest, and Output remains to the right of its final
producer. The bounded engine persists a frozen plan and fsynced journal, skips
validated completed work during replay, retries only runtime-authorized work as
a new attempt, and sends ambiguous effects to reconciliation instead of blindly
repeating them. Retry authority comes from an explicit registry for the frozen
operation name—not from plan-authored `local` or `external` labels—and external
retries also require a trusted provider idempotency key. A stable semantic
process node owns the frame, selection, collapse, dependencies, and exported
geometry. This is an explicitly dispatched, offline, single-host POSIX v1
recovery contract (including macOS; Windows is unsupported), not a generic
exactly-once guarantee or automatic conversion of ordinary agent runs. The
typed bridge surface accepts only two server-owned pure-local JSON operations;
bridge ready/reconnect performs read-only event replay without loading a chat
transcript or executing a workflow, and its read-only recovery snapshot marks
orphaned started receipts inactive until an explicit resume creates a new
attempt. See
[Durable compound workflows](../../docs/09-Agent/Durable-Compound-Workflows.md)
for the execution, event, graph, and smoke-test contract.

Starting another run in the same session appends to the same stable canonical
record. Moving to a new, forked, or resumed session starts a new live
projection so events from different sessions cannot be silently mixed.

- **Mouse and trackpad:** click the compact Flow card to open it. In the
  enlarged canvas, left-drag empty space or a block to pan like a CAD canvas;
  middle-drag pans without changing selection. Two-finger vertical and
  horizontal scrolling pans in all four directions, with Shift+vertical wheel
  retained as the horizontal fallback. Ctrl/Command plus a two-finger vertical
  gesture zooms around the pointer when the terminal reports the modifier;
  `+`/`-` remains the portable fallback. Click a block to select it, or click
  the simplified progress map in the right panel to select/recenter while its
  `[━]` range shows the enlarged viewport. Shift-drag remains the
  terminal-native text-selection override.
  Double-click an expandable capsule to enter it; a single click only selects
  it.
- **Keyboard:** `g`/`1`, `a`/`2`, `t`/`3`, `w`/`4`, `i`/`5`, and `f`/`6`
  select sections; `Tab` and `Shift+Tab` switch sections. In Flow, arrow keys or
  `h`/`j`/`k`/`l` select the nearest block. `Enter` enters an expandable
  Workflow, AGI node, or stage; on a leaf it focuses the inspector. `Esc` or
  `Backspace` exits one hierarchy level before `Esc` closes Flow at the root.
  `Space` folds or unfolds visible children, `F` toggles follow-live, `c`
  centers the selection, `r` re-runs deterministic layout, `+`/`-` changes
  semantic zoom across 50/75/100/125/150%, `0` fits the current hierarchy,
  `1` restores 100%, and `d` cycles overview/stages/workers. Shift+arrow pans by cells;
  `Home` selects the first block, `End` selects the active/latest block,
  `Page Up`/`Page Down` pans vertically, Shift+Page Up/Page Down pans
  horizontally.
- **Slash command:** `/panel goal`, `/panel agents`, `/panel todo`,
  `/panel agi`, `/panel flow`, `/panel details`, `/panel compact`, `/panel
  show`, `/panel hide`, and `/panel status`.
- **Draw.io export:** with the expanded Flow view focused, press `e` to export
  the exact current major hierarchy, or `Shift+E` to export the complete
  semantic hierarchy through workers. Both omit minor timeline events while
  retaining their folded event counts and inspector provenance. Sophia writes
  an editable, uncompressed `.drawio` `mxGraphModel` under
  `~/.sophia/exports/session-flows/`. Major-view blocks and routed waypoints use
  the same live geometry as the terminal view; full-hierarchy export computes
  its own complete layout. The exporter follows the cell/edge model used by
  [next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io); the
  terminal itself renders a bounded Ink projection rather than embedding a
  browser canvas.

Flow nodes deliberately retain only allow-listed labels and receipt metadata.
Raw tool arguments, raw tool output, token streams, and hidden reasoning are
not stored in the graph or its Draw.io export.

The details pane owns keyboard focus while open, so keystrokes cannot
accidentally edit the hidden prompt composer. Disable application mouse mode
with `--no-mouse` and use the keyboard controls above when terminal mouse
tracking is unavailable.

## Fullscreen

On a TTY, `sophia` enters the **alternate screen buffer** for a focused terminal
workspace. Leave with `/exit` or Ctrl+C.

```bash
sophia --no-fullscreen     # classic inline mode
SOPHIA_NO_FULLSCREEN=1 sophia
```

## Slash selection (fixed)

Type `/` then characters. **↑/↓** move the highlight, **Tab** completes the
selected command without running it, and **Enter** selects the highlighted
entry exactly once. Local/agent entries run their declared route; info and
unavailable entries explain that no action occurred. Commands such as `/model`,
`/effort`, `/mode`, `/permissions`, and `/theme` open an option picker; use
**↑/↓**, **Enter** to apply, or **Esc** to cancel.

The menu shows plain-language categories plus one honest execution badge:
`[local]`, `[agent]`, `[info]`, or `[unavailable]`. `/contract` is the
Sophia-native operating-contract entry.

`/resume` opens the recent-session browser. `/resume <exact-name>` restores that
session directly; when the argument is not an exact session identity, Sophia
searches id, title, topic, and full local transcript turns, then shows the
matching role and bounded context before anything is restored.

### ARC2 / ARC3 campaign operator view

`/arc` is a bounded, read-only operator flow for the shared ARC campaign
controller. It projects allowlisted JSON into explicit ARC2 and ARC3 status or
plan views:

```text
/arc status
/arc plan arc2
/arc plan arc3
/arc copy status
/arc copy plan arc2
/arc close
```

The view always labels candidates and submission authority separately:
`[CANDIDATE-ONLY]` and `[SUBMISSION-GATE: READY|BLOCKED|UNKNOWN]`. It presents
reported progress, heartbeat freshness, stall evidence, promotion gates, and
bounded compute budgets. A reported live PID is shown only as liveness
evidence; it is never treated as success without terminal receipts and passing
gates.

The only subprocess commands this flow can issue are:

```bash
python3 -m agent.arc_campaign status --json
python3 -m agent.arc_campaign plan --contest arc-agi-2 --json
python3 -m agent.arc_campaign plan --contest arc-agi-3 --json
```

Press `c` in the ARC panel to copy the displayed command or use `/arc copy ...`.
The TUI does **not** auto-submit, start public evaluation, stop/cancel a sealed
run, or expose arbitrary CLI JSON. Diagnostics pass through credential
redaction, and all unsupported operational verbs are refused locally.

## Sophia surfaces

| Surface | Behavior |
|---------|----------|
| Banner + statusline | model · effort · mode · permission · bridge · session; second line includes backend health, context, cost when known, and cwd |
| Prompt | Unicode-safe multiline editor; Shift/Alt+Enter newline; bracketed-paste review; local draft autosave; history/reverse search; ghost hints; `@file`, `@dir`, and `@image` references |
| Slash | type `/m` → `/model` `/mode` `/mcp`… (↑↓ Tab); `/model` groups runtimes/providers behind expandable headers; `/resume [session|text]` browses, loads an exact session, or searches full local transcript text |
| Messages | user · correlated/expandable tool cards · bounded diffs/output · thinking · assistant |
| Permissions | manual/auto/readonly; typed approval presentation; destructive local actions, possible-secret sends, and image generation require confirmation |
| Local slash | `/help` `/clear` `/model` `/fallback-model` `/theme` `/doctor` `/contract` `/exit` plus session, health, queue/steer, plan, and image controls |
| Prompt slash | `/review` `/commit` `/plan` `/thesis` `/brainstorm`… → agent goal |
| Workflow views | `/tasks` and `/workflows` show workflow receipts plus Sophia team-lane lifecycle/budget state; TeamoRouter ultramode identifies Sonnet 5 worker lanes and retains Opus 5 synthesis; backend capabilities decide available controls |
| ARC campaign | `/arc status` and `/arc plan arc2|arc3` show read-only candidate/submission-gate, progress, heartbeat, and stall receipts; live PID is not success |
| Orchestration-first tool use | Multi-step runs are classified locally before the first provider call (no goal/team planner call); the kernel groups only independent read-only native calls, keeps writes/dependencies serial, caches identical reads, and preserves result order |
| Plan mode | `/plan-mode <task>` creates an experimental local plan whose exact revision must be approved before execution |
| Session controls | browse/full-transcript search/new/fork/checkpoint/rename/tag/export/reset/archive; transcripts and metadata remain local-only |
| Debugging | `/doctor` runs no-spend provider/MCP diagnostics; `/debug bundle [path]` writes a redacted local support bundle without transcript bodies |
| Modes | `/mode divergent` is the brainstorm-style preset; `/thesis` and `/brainstorm` are prompt expansions, not hidden backend modes |
| Steering | Plain input during a run steers at a safe boundary; `/queue` schedules a distinct next run; `/bridge restart` reconnects only the child owned by this TUI |
| Images | `/image-provider` selects a configured provider; `/image [path ::] prompt` is confirmation-gated, output-scoped to the workspace, and blocked in readonly mode. Delegated CLI providers explicitly disclose that the external tool may use its own filesystem/network authority. |
| Accessibility | generic macOS/Windows/Linux terminal capability detection, screen-reader/reduced-motion/low-color modes, width collapse, and opt-in notifications |

## Protocol and persistence notes

Configuration defaults are layered: `~/.sophia/config.toml`, repository
`.sophia/config.toml`, `SOPHIA_CODE_CONFIG`, then `--config`; only `[code]` is
honored. Session transcripts are local JSON under the agent runs/session area;
there is no server retention or automatic cloud sync. Conversation exports and
traces can contain prompts, tool output, and provider text, so treat them as
sensitive; do not put credentials in prompts or logs. Redaction is not a promise
of complete secret removal.

Session-content search runs only after an explicit non-exact `/resume <text>`.
It scans the canonical local transcript arrays and keeps bounded match snippets
in memory; transcript bodies and search snippets are not persisted to the
rebuildable session index or included in support bundles by default.

The bridge uses correlated NDJSON v2 envelopes while retaining v1 compatibility.
A staged reconnect cancels, waits, terminates only the child owned by the TUI,
and performs a fresh ready handshake. Idempotent diagnostics may be replayed;
potentially side-effectful runs are never silently retried. A 429 may honor a
bounded `Retry-After`; cross-provider substitution remains confirmation-gated.
Cancel is best effort and may be rejected after a terminal boundary.

Provider empty output is reported as an empty result rather than invented text.
This is especially relevant for GLM and Codex transports: inspect the bridge
trace and provider debug/thinking logs before retrying. An empty response is not
a success claim.

`Shift+Tab` switches tool permission to auto; it does not cancel or steer a
run. `Ctrl+C` clears input, requests cancellation, or exits when idle (double
press). Session switching changes the local transcript path; it does not change
provider identity or resurrect an in-flight run.

`readonly` intentionally blocks shell/exec tools. An audit that must run
`--help`, a smoke command, or tests needs `--permission auto` (or manual
approvals) plus a non-mutating prompt. A denied bash tool call is permission
policy enforcement, not the subprocess's return code.

Tool-call efficiency is conservative and configurable. Independent read-only
native calls may use up to four workers; mutation/unknown-tool boundaries stay
serial. Set `SOPHIA_MAX_PARALLEL_TOOLS=1` to force serial execution,
`SOPHIA_TOOL_CACHE=0` to disable the exact-read cache, or
`SOPHIA_TOOL_FEEDBACK_CAP=0` to disable model-feedback truncation. These knobs
change scheduling/context cost only; they do not relax permission or delivery
gates.

Text-protocol/local models that cannot emit a native multi-tool batch can call
`read_batch` once with 1–8 already-known independent repository reads
(`read_file`, `list_dir`, `glob`, `grep`, `outline`, `find_symbol`). Exact
duplicates execute once, output rows stay in input order, and one child error
does not discard other results. Writes, shell, network, governance tools, and
recursive batches are excluded by the strict schema.

## Sync slash catalog after Python changes

```bash
npm run sync-slash
# or: python3 tools/export_slash_catalog.py
```

## Benchmarking models head-to-head

A standalone CLI runs the same gold-labelled task corpus across multiple models
and prints a comparison scorecard (quality + throughput). It is separate from
the TUI on purpose — a benchmark is a long-running offline job, not an
interactive command.

```bash
# Cloud / CLI models (prose-only, the fair surface for these three transports):
python -m agent.model_bench --models grok,qwen-coding,codex-5.6 \
    --corpus knowledge --max-cases 20

# Local-LLM throughput comparison (mlx vs ollama vs vllm):
python -m agent.model_bench \
    --models mlx:mlx-community/Qwen3.6-35B-A3B-4bit,ollama:qwen3:30b-a3b,vllm \
    --corpus philosophy

# Verify each backend is configured before paying for a full run:
python -m agent.model_bench --models grok,qwen-coding,codex-5.6 --smoke-only

# Dry-run against the mock preset (no API/CLI spend; proves the harness):
python -m agent.model_bench --models mock --corpus philosophy --max-cases 3
```

The scorecard carries `passed / score_pct` for every model, plus — when any
model reports token counts or cold-start latency — `median_lat_s`, `tok/s`, and
`cold_start_s` columns (the throughput axis that matters for local LLMs). A
JSON report is written to `agi-proof/benchmark-results/bench/`.

**Comparability caveat (enforced in the report):** `grok` and `codex-5.6` are
CLI transports that run their own loops, ignore sampling knobs, and don't
report token counts; `qwen-coding`, `mlx:`, `ollama:`, and `vllm:` are API/local
backends where Sophia stays the agent. Scores reflect the transport *as
configured*, not pure model capability. For a fair **tool-using** comparison,
swap to the API-kind presets `xai` (grok-4.5 over the xAI API) and `codex-api`
(codex over the local proxy) — both go through the same tool-calling path as
`qwen-coding`. Reports are `candidateOnly: true`, `canClaimAGI: false`.

## Architecture

```
sophia-tui (Ink)
    │  NDJSON
    ▼
agent.code_bridge
    ▼
agent.agent_loop + Sophia operating-contract harness + model (zai/codex/…)
```
