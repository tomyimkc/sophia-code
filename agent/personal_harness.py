# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Personal Sophia harness orchestration.

Loads layered operator policy, selects only relevant memory/skills/context, and
writes compact receipts.  The classic harness remains the default; ``personal-v2``
is an explicit rollout profile.

candidateOnly; canClaimAGI:false — no capability or promotion claim.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from agent import runtime_paths
from agent.personal_memory import (
    MemoryHit,
    PersonalMemoryStore,
    extract_explicit_memory_candidates,
    search_transcripts,
)

PERSONAL_TOOL_NAMES = frozenset(
    {
        "personal_memory_search",
        "personal_memory_write",
        "personal_memory_write_sensitive",
        "personal_artifact_stage",
    }
)
_TRUE = frozenset({"1", "true", "yes", "on"})
_CURRENT_MARKERS = re.compile(
    r"\b(?:latest|current|currently|today|tonight|tomorrow|yesterday|recent|"
    r"newest|still|price|schedule|score|weather|law|policy|release|version|"
    r"ceo|president|status)\b",
    re.IGNORECASE,
)
_NICHE_MARKERS = re.compile(
    r"\b(?:paper|benchmark|standard|specification|rfc|cve|emerging|niche|"
    r"unfamiliar|verify|look up|search|browse)\b",
    re.IGNORECASE,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _deep_merge(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    out = dict(left)
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _toml_layers(root: Path) -> list[Path]:
    paths = [runtime_paths.user_state_dir() / "config.toml", root / ".sophia" / "config.toml"]
    explicit = (os.environ.get("SOPHIA_CODE_CONFIG") or "").strip()
    if explicit:
        paths.append(Path(explicit).expanduser())
    return paths


def _load_toml(root: Path) -> dict[str, Any]:
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ModuleNotFoundError:
            return {}
    merged: dict[str, Any] = {}
    for path in _toml_layers(root):
        if not path.exists():
            continue
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError):
            continue
        if isinstance(data, dict):
            merged = _deep_merge(merged, data)
    return merged


def _bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in _TRUE


def _int(value: Any, default: int, *, lower: int, upper: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(lower, min(upper, parsed))


@dataclass(frozen=True)
class ConnectorPolicy:
    name: str
    enabled: bool = True
    read: str = "auto"
    write: str = "confirm"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PersonalHarnessConfig:
    profile: str = "classic"
    prompt_budget_local: int = 4_500
    prompt_budget_cloud: int = 16_000
    memory_enabled: bool = True
    memory_auto_write: bool = True
    memory_sensitive: str = "ask_encrypt"
    recall_enabled: bool = True
    recall_memory_limit_local: int = 4
    recall_memory_limit_cloud: int = 8
    recall_chat_limit_local: int = 3
    recall_chat_limit_cloud: int = 6
    skills_auto: bool = True
    skills_top_local: int = 1
    skills_top_cloud: int = 3
    research_auto: bool = True
    receipts_enabled: bool = True
    artifacts_enabled: bool = True
    connectors: tuple[ConnectorPolicy, ...] = field(default_factory=tuple)

    @property
    def enabled(self) -> bool:
        return self.profile.casefold() in {"personal-v2", "personal", "v2"}


@dataclass(frozen=True)
class HarnessSelection:
    prompt_extra: str
    memory_hits: tuple[MemoryHit, ...]
    chat_hits: tuple[MemoryHit, ...]
    skills: tuple[dict[str, Any], ...]
    research: dict[str, Any]
    connectors: tuple[ConnectorPolicy, ...]
    memory_writes: tuple[dict[str, Any], ...] = ()

    def receipt_dict(self) -> dict[str, Any]:
        return {
            "memory": [hit.receipt_dict() for hit in self.memory_hits],
            "pastChats": [hit.receipt_dict() for hit in self.chat_hits],
            "skills": list(self.skills),
            "research": dict(self.research),
            "connectors": [connector.to_dict() for connector in self.connectors],
            "memoryWrites": list(self.memory_writes),
        }


def load_harness_config(root: Path) -> PersonalHarnessConfig:
    data = _load_toml(root)
    prompt = data.get("prompt") if isinstance(data.get("prompt"), dict) else {}
    memory = data.get("memory") if isinstance(data.get("memory"), dict) else {}
    recall = data.get("recall") if isinstance(data.get("recall"), dict) else {}
    skills = data.get("skills") if isinstance(data.get("skills"), dict) else {}
    research = data.get("research") if isinstance(data.get("research"), dict) else {}
    receipts = data.get("receipts") if isinstance(data.get("receipts"), dict) else {}
    artifacts = data.get("artifacts") if isinstance(data.get("artifacts"), dict) else {}
    connectors_table = data.get("connectors") if isinstance(data.get("connectors"), dict) else {}
    env_profile = (os.environ.get("SOPHIA_HARNESS_PROFILE") or "").strip()
    connector_rows: list[ConnectorPolicy] = []
    for name in ("github", "google"):
        raw = connectors_table.get(name)
        row = raw if isinstance(raw, dict) else {}
        connector_rows.append(
            ConnectorPolicy(
                name=name,
                enabled=_bool(row.get("enabled"), True),
                read=str(row.get("read") or "auto").strip().lower(),
                write=str(row.get("write") or "confirm").strip().lower(),
            )
        )
    return PersonalHarnessConfig(
        profile=env_profile or str(prompt.get("profile") or "classic"),
        prompt_budget_local=_int(
            prompt.get("local_budget_tokens"),
            4_500,
            lower=2_000,
            upper=24_000,
        ),
        prompt_budget_cloud=_int(
            prompt.get("cloud_budget_tokens"),
            16_000,
            lower=4_000,
            upper=64_000,
        ),
        memory_enabled=_bool(memory.get("enabled"), True),
        memory_auto_write=_bool(memory.get("auto_write"), True),
        memory_sensitive=str(memory.get("sensitive") or "ask_encrypt"),
        recall_enabled=_bool(recall.get("enabled"), True),
        recall_memory_limit_local=_int(
            recall.get("memory_limit_local"), 4, lower=0, upper=12
        ),
        recall_memory_limit_cloud=_int(
            recall.get("memory_limit_cloud"), 8, lower=0, upper=20
        ),
        recall_chat_limit_local=_int(
            recall.get("chat_limit_local"), 3, lower=0, upper=10
        ),
        recall_chat_limit_cloud=_int(
            recall.get("chat_limit_cloud"), 6, lower=0, upper=20
        ),
        skills_auto=_bool(skills.get("auto"), True),
        skills_top_local=_int(skills.get("top_local"), 1, lower=0, upper=3),
        skills_top_cloud=_int(skills.get("top_cloud"), 3, lower=0, upper=5),
        research_auto=_bool(research.get("auto"), True),
        receipts_enabled=_bool(receipts.get("enabled"), True),
        artifacts_enabled=_bool(artifacts.get("enabled"), True),
        connectors=tuple(connector_rows),
    )


def research_route(request: str, *, enabled: bool) -> dict[str, Any]:
    if not enabled:
        return {"decision": "off", "reason": "disabled by config"}
    if _CURRENT_MARKERS.search(request):
        return {"decision": "verify", "reason": "time-sensitive or mutable request"}
    if _NICHE_MARKERS.search(request):
        return {"decision": "verify", "reason": "niche, source-specific, or explicit lookup request"}
    return {"decision": "direct", "reason": "no deterministic current/niche trigger"}


def _clip(text: str, length: int) -> str:
    clean = " ".join(text.split())
    return clean if len(clean) <= length else clean[: length - 1].rstrip() + "…"


def _render_memory(hits: Iterable[MemoryHit], *, local: bool) -> str:
    rows = list(hits)
    if not rows:
        return ""
    cap = 220 if local else 420
    lines = [
        "## Relevant personal/work context",
        "Use only when it changes the answer. Do not mention the memory system.",
    ]
    for hit in rows:
        role = "user stated" if hit.role == "user" else "assistant previously suggested"
        lines.append(
            f"- [{role}; {hit.kind}/{hit.subject}] {_clip(hit.text, cap)}"
        )
    lines.append(
        "Never promote an assistant suggestion or hypothetical into a user decision."
    )
    return "\n".join(lines)


def _render_skills(skills: Iterable[dict[str, Any]], *, local: bool) -> str:
    rows = list(skills)
    if not rows:
        return ""
    lines = [
        "## Auto-selected skills",
        "These workflows were selected deterministically for this request. Follow only the relevant steps.",
    ]
    step_cap = 4 if local else 8
    for row in rows:
        workflow = row.get("workflow") if isinstance(row.get("workflow"), list) else []
        verification = row.get("verification") if isinstance(row.get("verification"), list) else []
        lines.append(f"### {row['name']}")
        for idx, step in enumerate(workflow[:step_cap], 1):
            lines.append(f"{idx}. {_clip(str(step), 220 if local else 380)}")
        if verification:
            lines.append(
                "Verify: "
                + "; ".join(_clip(str(item), 160) for item in verification[:2 if local else 4])
            )
    return "\n".join(lines)


def _render_policy(
    config: PersonalHarnessConfig,
    *,
    research: dict[str, Any],
    local: bool,
) -> str:
    connector_bits = ", ".join(
        f"{row.name}(read={row.read}, write={row.write})"
        for row in config.connectors
        if row.enabled
    ) or "none"
    lines = [
        "## Personal harness policy",
        "- Search personal memory before asking for durable user/work context that may already exist.",
        "- Write memory only for explicit user-stated durable facts, decisions, and response preferences.",
        "- Never infer personal facts. Sensitive facts require explicit approval and encrypted storage.",
        "- Apply recalled details only when they materially change the response.",
        f"- Connector authority: {connector_bits}. A connector write requires confirmation unless its policy explicitly says auto.",
    ]
    if research.get("decision") == "verify":
        lines.append(
            "- This request needs current/source verification. Use an available search or source tool before asserting mutable facts."
        )
    if local:
        lines.append(
            "- Local-model mode: keep plans short, use one tool call at a time, and prefer deterministic tools over long internal deliberation."
        )
    return "\n".join(lines)


def prepare_harness_selection(
    *,
    config: PersonalHarnessConfig,
    request: str,
    root: Path,
    history: Iterable[dict[str, Any]],
    session: str,
    local: bool,
    manual_skill: str | None = None,
    user_text: str | None = None,
) -> HarnessSelection:
    if not config.enabled:
        return HarnessSelection("", (), (), (), research_route(request, enabled=False), (), ())

    memory_hits: list[MemoryHit] = []
    chat_hits: list[MemoryHit] = []
    memory_writes: list[dict[str, Any]] = []
    if config.memory_enabled and config.memory_auto_write:
        store = PersonalMemoryStore()
        for candidate in extract_explicit_memory_candidates(
            request if user_text is None else user_text,
            workspace=root,
        ):
            try:
                result = store.write_fact(
                    namespace=candidate.namespace,
                    subject=candidate.subject,
                    fact=candidate.fact,
                    source_role="user",
                )
            except Exception as exc:  # noqa: BLE001 - optional capture fails closed
                memory_writes.append(
                    {
                        "namespace": candidate.namespace,
                        "subject": candidate.subject,
                        "status": "failed",
                        "reason": type(exc).__name__,
                    }
                )
                continue
            memory_writes.append(
                {
                    "namespace": candidate.namespace,
                    "subject": candidate.subject,
                    "status": result.status,
                    "sensitive": result.sensitive,
                    "reason": result.reason,
                }
            )
    if config.memory_enabled and config.recall_enabled:
        memory_limit = (
            config.recall_memory_limit_local
            if local
            else config.recall_memory_limit_cloud
        )
        chat_limit = (
            config.recall_chat_limit_local
            if local
            else config.recall_chat_limit_cloud
        )
        try:
            memory_hits = PersonalMemoryStore().search(
                request,
                limit=memory_limit,
                workspace=root,
                include_sensitive=False,
            )
        except Exception:  # noqa: BLE001 - recall is optional, never blocks execution
            memory_hits = []
        try:
            chat_hits = search_transcripts(
                request,
                current_history=history,
                current_session=session,
                limit=chat_limit,
            )
        except Exception:  # noqa: BLE001
            chat_hits = []

    selected: list[dict[str, Any]] = []
    if config.skills_auto and not manual_skill:
        try:
            from agent.skills import select_ranked

            top_k = config.skills_top_local if local else config.skills_top_cloud
            for row in select_ranked(request, top_k=top_k):
                skill = row.get("skill") if isinstance(row.get("skill"), dict) else {}
                if not skill.get("name"):
                    continue
                selected.append(
                    {
                        "name": str(skill["name"]),
                        "score": round(float(row.get("score") or 0.0), 4),
                        "via": str(row.get("via") or "unknown"),
                        "workflow": list(skill.get("workflow") or []),
                        "verification": list(skill.get("verification") or []),
                    }
                )
        except Exception:  # noqa: BLE001
            selected = []
    research = research_route(request, enabled=config.research_auto)
    blocks = [
        _render_policy(config, research=research, local=local),
        _render_memory([*memory_hits, *chat_hits], local=local),
        _render_skills(selected, local=local),
    ]
    return HarnessSelection(
        prompt_extra="\n\n".join(block for block in blocks if block),
        memory_hits=tuple(memory_hits),
        chat_hits=tuple(chat_hits),
        skills=tuple(selected),
        research=research,
        connectors=config.connectors,
        memory_writes=tuple(memory_writes),
    )


def receipt_dir(session: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", session).strip("._") or "default"
    return runtime_paths.user_state_dir() / "receipts" / safe


def artifact_dir(session: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", session).strip("._") or "default"
    return runtime_paths.user_state_dir() / "artifacts" / safe


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def write_harness_receipt(
    *,
    session: str,
    run_id: str,
    root: Path,
    local: bool,
    config: PersonalHarnessConfig,
    selection: HarnessSelection,
    prompt_receipt: dict[str, Any],
) -> Path | None:
    if not config.enabled or not config.receipts_enabled:
        return None
    payload = {
        "schema": "sophia.personal-harness.receipt.v1",
        "timestamp": _now(),
        "runId": run_id,
        "session": session,
        "workspace": str(root),
        "profile": config.profile,
        "modelClass": "local" if local else "cloud",
        "selection": selection.receipt_dict(),
        "prompt": prompt_receipt,
        "candidateOnly": True,
        "canClaimAGI": False,
    }
    directory = receipt_dir(session)
    path = directory / f"{run_id}.json"
    _atomic_json(path, payload)
    _atomic_json(directory / "latest.json", payload)
    return path


def stage_artifact(
    *,
    session: str,
    name: str,
    content: str,
    media_type: str = "text/markdown",
) -> Path:
    """Stage a text artifact outside the repo and return its durable path."""
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip(".-") or "artifact.md"
    if "." not in safe:
        safe += ".md" if media_type == "text/markdown" else ".txt"
    directory = artifact_dir(session)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / safe
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=directory)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return path


__all__ = [
    "ConnectorPolicy",
    "HarnessSelection",
    "PERSONAL_TOOL_NAMES",
    "PersonalHarnessConfig",
    "artifact_dir",
    "load_harness_config",
    "prepare_harness_selection",
    "receipt_dir",
    "research_route",
    "stage_artifact",
    "write_harness_receipt",
]
