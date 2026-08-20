#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Open-edition catalog + kernel delivery skip. Script-mode; canClaimAGI:false."""
from __future__ import annotations

import importlib
import inspect
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.edition import (  # noqa: E402
    EDITION_FULL,
    EDITION_OSS,
    FULL_ONLY_COMMANDS,
    active_edition,
    command_in_edition,
    edition_skips_conscience_gate,
    edition_unavailable_message,
    editions_for_command,
)


def _clear_edition_env() -> None:
    os.environ.pop("SOPHIA_EDITION", None)


def test_default_edition_is_full_in_this_repo() -> None:
    _clear_edition_env()
    importlib.reload(sys.modules["agent.edition"])
    from agent.edition import active_edition as fresh

    assert fresh() in {EDITION_FULL, EDITION_OSS}
    assert edition_skips_conscience_gate() is False


def test_env_selects_oss() -> None:
    os.environ["SOPHIA_EDITION"] = "oss"
    try:
        assert active_edition() == EDITION_OSS
        assert edition_skips_conscience_gate() is True
    finally:
        _clear_edition_env()


def test_invalid_env_does_not_invent_an_edition() -> None:
    os.environ["SOPHIA_EDITION"] = "enterprise"
    try:
        assert active_edition() == EDITION_FULL
    finally:
        _clear_edition_env()


def test_full_only_commands_are_hidden_from_oss() -> None:
    for name in (
        "conscience",
        "effort",
        "ultramode",
        "a2a",
        "workflow",
        "agi",
        "graph",
        "goal",
        "panel",
    ):
        assert name in FULL_ONLY_COMMANDS, name
        assert editions_for_command(name) == (EDITION_FULL,)
        assert command_in_edition(name, edition=EDITION_OSS) is False
        assert command_in_edition(name, edition=EDITION_FULL) is True


def test_oss_compound_replay_is_quiet() -> None:
    os.environ["SOPHIA_EDITION"] = "oss"
    try:
        from agent.edition import is_oss_edition

        assert is_oss_edition() is True
        from agent.code_bridge import CodeBridge

        rows: list[dict] = []
        bridge = CodeBridge.__new__(CodeBridge)
        bridge.emit = lambda payload: rows.append(payload)  # type: ignore[method-assign]
        bridge.error = lambda *a, **k: rows.append({"error": True, "args": a, "kwargs": k})  # type: ignore[method-assign]
        CodeBridge._handle_compound_workflow(bridge, {"action": "replay", "session": "smoke"})
        assert rows and rows[-1].get("ok") is True
        assert rows[-1].get("type") == "compound_workflow_status"
        assert not any(row.get("error") for row in rows)
        rows.clear()
        CodeBridge._handle_compound_workflow(bridge, {"action": "run", "session": "smoke"})
        assert any(row.get("error") for row in rows)
    finally:
        _clear_edition_env()


def test_coding_cli_commands_remain_in_oss() -> None:
    for name in ("model", "permissions", "plan", "resume", "compact", "help"):
        assert command_in_edition(name, edition=EDITION_OSS) is True


def test_unavailable_message_names_the_command_and_not_agi() -> None:
    text = edition_unavailable_message("workflow")
    assert "/workflow" in text
    assert "open edition" in text
    assert "AGI" not in text


def test_catalog_resolve_and_suggest_honor_oss_edition() -> None:
    os.environ["SOPHIA_EDITION"] = "oss"
    try:
        import agent.slash_catalog as catalog

        importlib.reload(catalog)
        hidden = {c.name for c in catalog.visible_commands()}
        for name in ("conscience", "effort", "a2a", "workflow", "agi", "graph"):
            assert name not in hidden, name
            cmd, resolved, _ = catalog.resolve(f"/{name}")
            assert cmd is None, name
            assert resolved == name
        visible = hidden
        assert "model" in visible
        assert "permissions" in visible
        assert "plan" in visible
        public = catalog.public_catalog()
        assert public["canClaimAGI"] is False
        assert public["product_defaults"]["defaultEdition"] == "full"
        effort = next(c for c in public["commands"] if c["name"] == "effort")
        assert effort["editions"] == ["full"]
        model = next(c for c in public["commands"] if c["name"] == "model")
        assert "oss" in model["editions"]
        oss = catalog.public_catalog_for_edition("oss")
        oss_names = {c["name"] for c in oss["commands"]}
        assert "effort" not in oss_names
        assert "agi" not in oss_names
        assert "model" in oss_names
        assert oss["product_defaults"]["defaultEdition"] == "oss"
        assert oss["canClaimAGI"] is False
    finally:
        _clear_edition_env()
        import agent.slash_catalog as catalog

        importlib.reload(catalog)


def test_keyword_commands_cannot_leak_into_oss() -> None:
    from agent.slash_catalog import all_commands

    markers = {
        "a2a",
        "agi",
        "conscience",
        "effort",
        "ultramode",
        "workflow",
        "workflows",
    }
    for cmd in all_commands():
        if cmd.name in markers or cmd.name.startswith("agi"):
            eds = editions_for_command(cmd.name, cmd.editions)
            assert EDITION_OSS not in eds, cmd.name


def test_oss_final_gate_does_not_import_conscience_runtime() -> None:
    os.environ["SOPHIA_EDITION"] = "oss"
    sys.modules.pop("agent.conscience_runtime", None)
    try:
        import agent.agent_loop as loop

        importlib.reload(loop)
        text, ok, downgraded, status = loop._gate_final(  # noqa: SLF001 — tested seam
            "the tests pass",
            trace_path="",
            goal="say whether the tests pass",
        )
        assert ok is True
        assert downgraded is False
        assert text == "the tests pass"
        assert status["canClaimAGI"] is False
        assert status["floorChecked"] is False
        assert "agent.conscience_runtime" not in sys.modules
    finally:
        _clear_edition_env()
        import agent.agent_loop as loop

        importlib.reload(loop)


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and inspect.isfunction(fn):
            fn()
    print("test_sophia_edition: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
