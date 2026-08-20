# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Repo operator tools — execution requires explicit approval."""

from __future__ import annotations

import json
import subprocess
import sys

from agent.config import ROOT

TOOL_CATALOG = {
    "validate": {
        "description": "Validate attributions and training examples",
        "command": [sys.executable, "tools/validate_attribution.py"],
        "risk": "low",
    },
    "export_corpus": {
        "description": "Export training/examples to corpus.jsonl",
        "command": [sys.executable, "tools/export_training_jsonl.py"],
        "risk": "low",
    },
    "build_reference": {
        "description": "Build benchmark reference responses from case_map",
        "command": [sys.executable, "tools/build_reference_responses.py"],
        "risk": "low",
    },
    "update_leaderboards": {
        "description": "Refresh domain leaderboards from reports",
        "command": [sys.executable, "tools/update_leaderboards.py"],
        "risk": "low",
    },
    "benchmark_claude": {
        "description": "Run Claude on all domain benchmarks (API cost)",
        "command": [sys.executable, "tools/run_external_models.py", "--all", "--providers", "claude-sonnet"],
        "risk": "high",
    },
    "upload_hf": {
        "description": "Upload corpus.jsonl to Hugging Face",
        "command": [sys.executable, "tools/upload_huggingface.py"],
        "risk": "medium",
    },
    "upload_hf_adapter": {
        "description": "Upload LoRA adapter to Hugging Face model repo",
        "command": [sys.executable, "tools/upload_huggingface_adapter.py", "--approve"],
        "risk": "medium",
    },
}


def catalog_text() -> str:
    lines = ["Available repo tools (require --approve to execute):"]
    for name, spec in TOOL_CATALOG.items():
        lines.append(f"- **{name}** ({spec['risk']}): {spec['description']}")
    return "\n".join(lines)


def parse_tool_requests(text: str) -> list[str]:
    """Extract tool names from a JSON block: {"tools": ["export_corpus", ...]}."""
    match = re_search_json_tools(text)
    if not match:
        return []
    try:
        payload = json.loads(match)
        tools = payload.get("tools", [])
        return [t for t in tools if t in TOOL_CATALOG]
    except json.JSONDecodeError:
        return []


def re_search_json_tools(text: str) -> str | None:
    import re

    for block in re.findall(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL):
        if "tools" in block:
            return block
    start = text.find('{"tools"')
    if start == -1:
        return None
    end = text.find("}", start) + 1
    if end <= start:
        return None
    return text[start:end]


def run_tool(name: str, *, approved: bool) -> dict:
    if name not in TOOL_CATALOG:
        return {"tool": name, "ok": False, "error": "unknown tool"}
    if not approved:
        return {"tool": name, "ok": False, "error": "not approved — pass --approve"}
    spec = TOOL_CATALOG[name]
    result = subprocess.run(spec["command"], cwd=ROOT, capture_output=True, text=True)
    return {
        "tool": name,
        "ok": result.returncode == 0,
        "stdout": result.stdout[-2000:] if result.stdout else "",
        "stderr": result.stderr[-1000:] if result.stderr else "",
        "returncode": result.returncode,
    }


def run_tools(names: list[str], *, approved: bool) -> list[dict]:
    return [run_tool(name, approved=approved) for name in names]