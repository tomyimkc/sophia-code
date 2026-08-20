# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""`sophia lite` open-edition invocation (TUI or Python CLI).

Packaging only. ``canClaimAGI`` stays false.
"""
from __future__ import annotations

from typing import Mapping

LITE_TOKENS = frozenset({"lite", "--lite"})

# Flags that mean "run agent.cli", not the Ink TUI. `-p` is --prompt here
# (same as `sophia -p`); the TUI permission flag is `--permission`.
_CLI_ONLY_FLAGS = frozenset({
    "-p",
    "--prompt",
    "--json",
    "--streaming-json",
    "-h",
    "--help",
    "--auto",
    "--yolo",
    "--full-access",
    "--readonly",
    "--no-tools",
    "--trace",
    "--show-thinking",
    "--capture-thinking",
    "--logic-judge",
})
_VALUE_FLAGS = frozenset({
    "-p",
    "--prompt",
    "-m",
    "--model",
    "--adapter",
    "--server",
    "--cwd",
    "--max-steps",
    "--session",
    "--config",
    "--trace",
    "--mode",
    "--effort",
    "--temperature",
    "--temperature-preset",
    "--permission",
    "--logic-judge",
    "--thinking-log",
    "--top-p",
    "--top-k",
})


def is_lite_invocation(argv: list[str]) -> bool:
    return bool(argv) and argv[0] in LITE_TOKENS


def consume_lite_argv(argv: list[str]) -> list[str]:
    if is_lite_invocation(argv):
        return list(argv[1:])
    return list(argv)


def wants_python_cli(argv: list[str]) -> bool:
    """True when argv should run ``agent.cli`` instead of the Ink TUI."""
    skip_value = False
    for token in argv:
        if skip_value:
            skip_value = False
            continue
        if token == "--":
            return True
        if token in _CLI_ONLY_FLAGS:
            return True
        if token.startswith("-p=") or token.startswith("--prompt="):
            return True
        if token.startswith("--json") or token.startswith("--streaming-json"):
            return True
        if "=" in token and token.split("=", 1)[0] in _VALUE_FLAGS:
            continue
        if token in _VALUE_FLAGS:
            skip_value = True
            continue
        if token.startswith("-"):
            continue
        return True
    return False


def prepare_lite_env(
    argv: list[str],
    *,
    env: Mapping[str, str],
) -> tuple[list[str], dict[str, str]]:
    """Strip the lite token and return (rest argv, env updates)."""
    rest = consume_lite_argv(argv)
    ui = (env.get("SOPHIA_UI") or "").strip()
    if not ui:
        # Bare `sophia lite` must open the Ink TUI even when stdout is not a
        # detected tty (cmux/tmux/IDE launchers). `auto` falls through to the
        # Python REPL in those environments. CLI flags still select python.
        ui = "python" if wants_python_cli(rest) else "tui"
    patch = {
        "SOPHIA_EDITION": env.get("SOPHIA_EDITION") or "oss",
        "SOPHIA_UI": ui,
    }
    return rest, patch
