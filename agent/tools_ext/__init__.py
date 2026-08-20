# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Plugin seam for the Sophia Agents toolset.

Each capability is a self-contained module in this package that exports a
``TOOL_SPECS`` list of :class:`agent.agent_tools.ToolSpec`. The core toolset
(``agent.agent_tools.all_tools``) auto-discovers them, so capabilities can be built
independently — no shared registry to edit, no merge conflicts.

Contract for a plugin module ``agent/tools_ext/<name>.py``:

* Define ``TOOL_SPECS: list[ToolSpec]`` at module top level.
* Each ``ToolSpec.fn`` has signature ``fn(args: dict, ctx: ToolContext) -> str`` and
  returns human/model-readable text (it will be secret-redacted + truncated for you).
* Import optional third-party deps INSIDE the fn (or guard at import), so a missing
  dependency makes the plugin unavailable rather than breaking the whole toolset.
* Use ``ctx.root`` (working dir), ``ctx.permission``, ``ctx.client`` (model client,
  for LLM-using tools) as needed. Pick the right risk class (safe/write/exec).

candidateOnly; canClaimAGI:false.
"""
from __future__ import annotations

import importlib
import pkgutil
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent.agent_tools import ToolSpec


def discover_ext_tools() -> "dict[str, ToolSpec]":
    """Import every non-underscore module here and collect their ``TOOL_SPECS``.

    A module that raises on import (e.g. an optional dependency is absent) is skipped
    — the capability is simply unavailable; the rest of the toolset is unaffected.
    """
    found: "dict[str, ToolSpec]" = {}
    for mod in pkgutil.iter_modules(__path__):
        if mod.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{mod.name}")
        except Exception:  # noqa: BLE001 - optional-dependency plugins degrade to unavailable
            continue
        for spec in getattr(module, "TOOL_SPECS", []) or []:
            found[spec.name] = spec
        # Optional dynamic hook: a module may export ``tool_specs()`` returning a
        # list[ToolSpec] computed at discovery time (e.g. env-gated tools). This is
        # re-evaluated on every discover() call (all_tools(refresh=True)), unlike the
        # import-once TOOL_SPECS — so env-flag-gated tools reflect the current flag.
        dyn = getattr(module, "tool_specs", None)
        if callable(dyn):
            try:
                for spec in dyn() or []:
                    found[spec.name] = spec
            except Exception:  # noqa: BLE001 - a dynamic plugin must not break discovery
                pass
    return found


__all__ = ["discover_ext_tools"]
