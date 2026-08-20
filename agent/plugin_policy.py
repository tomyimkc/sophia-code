# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Fail-closed policy for Sophia plugin permissions and workflow proposals."""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping

try:
    from agent.dynamic_workflow import (
        MAX_AGENTS_SAFETY,
        MAX_STAGES_SAFETY,
    )
except ImportError:  # open edition does not ship /workflow
    MAX_STAGES_SAFETY = 12
    MAX_AGENTS_SAFETY = 64

if TYPE_CHECKING:
    from agent.plugin_manifest import PluginSandboxPolicy

KNOWN_PERMISSIONS = frozenset(
    {
        "skill.provide",
        "agent.provide",
        "workflow.propose",
        "runtime.execute",
        "process.spawn",
        "filesystem.read",
        "filesystem.write",
        "network.access",
        "environment.read",
    }
)
EXECUTABLE_PERMISSIONS = frozenset(
    {
        "runtime.execute",
        "process.spawn",
        "filesystem.read",
        "filesystem.write",
        "network.access",
        "environment.read",
    }
)
PROFILE_SETTING_KEYS = frozenset(
    {
        "workflowMode",
        "workflowMaxStages",
        "workflowMaxAgents",
        "a2aAgents",
        "a2aExecution",
        "terminalLayout",
        "autoTeam",
        "team",
        "deepMode",
        "responseStyle",
    }
)
FORBIDDEN_SETTING_KEYS = frozenset(
    {
        "gateBypass",
        "permission",
        "runtime",
        "model",
        "conscienceMode",
        "agiMode",
        "agiProfile",
        "semanticFallbackModel",
        "semanticFallbackPolicy",
        "promotion",
        "protectedSuites",
        "canClaimAGI",
    }
)


class PluginPolicyError(ValueError):
    """Raised when a plugin asks for authority outside the public contract."""


@dataclass(frozen=True)
class SettingsProposal:
    patch: Mapping[str, Any]
    source: str
    requires_user_action: bool = True
    candidate_only: bool = True
    can_claim_agi: bool = False


def validate_permissions(
    permissions: tuple[str, ...] | list[str],
    *,
    executable: bool,
    trust_tier: int,
    sandbox: "PluginSandboxPolicy | None" = None,
) -> tuple[str, ...]:
    unknown = sorted(set(permissions) - KNOWN_PERMISSIONS)
    if unknown:
        raise PluginPolicyError(
            "unknown plugin permission(s): " + ", ".join(unknown)
        )
    requested = tuple(dict.fromkeys(str(item) for item in permissions))
    if executable:
        if trust_tier != 4:
            raise PluginPolicyError(
                "executable plugins must use supervised trustTier 4"
            )
        if "process.spawn" not in requested:
            raise PluginPolicyError(
                "executable plugins must declare process.spawn"
            )
        sandbox_mode = getattr(sandbox, "mode", "off")
        if sandbox_mode == "required":
            filesystem = getattr(sandbox, "filesystem", "plugin-only")
            network = getattr(sandbox, "network", "deny")
            actual_os_user_capabilities: set[str] = set()
            if filesystem in {"workspace-read", "workspace-write"}:
                actual_os_user_capabilities.add("filesystem.read")
            if filesystem == "workspace-write":
                actual_os_user_capabilities.add("filesystem.write")
            if network == "allow":
                actual_os_user_capabilities.add("network.access")
            denied = sorted(
                {
                    "filesystem.read",
                    "filesystem.write",
                    "network.access",
                }
                & set(requested)
                - actual_os_user_capabilities
            )
            if denied:
                raise PluginPolicyError(
                    "required sandbox policy denies declared permission(s): "
                    + ", ".join(denied)
                )
        else:
            # Optional isolation may be unavailable. Its fallback is therefore
            # still an OS-user process and must disclose the same broad
            # capabilities as an explicitly unsandboxed sidecar.
            actual_os_user_capabilities = {
                "filesystem.read",
                "filesystem.write",
                "network.access",
            }
        missing = sorted(actual_os_user_capabilities - set(requested))
        if missing:
            raise PluginPolicyError(
                "executable plugin policy requires permission(s): "
                + ", ".join(missing)
            )
    elif set(requested) & EXECUTABLE_PERMISSIONS:
        raise PluginPolicyError(
            "declarative plugins cannot request executable permissions"
        )
    return requested


def permissions_need_approval(permissions: tuple[str, ...] | list[str]) -> bool:
    return bool(set(permissions) & EXECUTABLE_PERMISSIONS)


def _strict_manifest_integer(
    value: Any,
    *,
    key: str,
    minimum: int,
    maximum: int,
) -> int:
    """Validate a plugin-owned integer without CLI-style coercion or clamping."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise PluginPolicyError(f"{key} must be an integer")
    if value < minimum or value > maximum:
        raise PluginPolicyError(
            f"{key} must be between {minimum} and {maximum}"
        )
    return value


def _normalize_profile_value(key: str, value: Any) -> Any:
    if key == "workflowMode":
        if not isinstance(value, str) or value not in {"off", "auto", "on"}:
            raise PluginPolicyError("workflowMode must be off, auto, or on")
        return value
    if key == "workflowMaxStages":
        return _strict_manifest_integer(
            value,
            key=key,
            minimum=1,
            maximum=MAX_STAGES_SAFETY,
        )
    if key == "workflowMaxAgents":
        return _strict_manifest_integer(
            value,
            key=key,
            minimum=2,
            maximum=MAX_AGENTS_SAFETY,
        )
    if key == "a2aAgents":
        agents = _strict_manifest_integer(
            value,
            key=key,
            minimum=-1,
            maximum=64,
        )
        if agents == 1:
            raise PluginPolicyError(
                "a2aAgents must be -1, 0, or between 2 and 64"
            )
        return agents
    if key == "a2aExecution":
        if (
            not isinstance(value, str)
            or value not in {"embedded", "terminal", "headless"}
        ):
            raise PluginPolicyError(
                "a2aExecution must be embedded, terminal, or headless"
            )
        return value
    if key == "terminalLayout":
        if (
            not isinstance(value, str)
            or value not in {"off", "auto", "splits", "windows", "headless"}
        ):
            raise PluginPolicyError(
                "terminalLayout must be off, auto, splits, windows, or headless"
            )
        return value
    if key in {"autoTeam", "deepMode"}:
        if not isinstance(value, bool):
            raise PluginPolicyError(f"{key} must be boolean")
        return value
    if key == "team":
        return _strict_manifest_integer(
            value,
            key=key,
            minimum=1,
            maximum=8,
        )
    if key == "responseStyle":
        if (
            not isinstance(value, str)
            or value not in {"adaptive", "concise", "explanatory", "structured"}
        ):
            raise PluginPolicyError(
                "responseStyle must be adaptive, concise, explanatory, or structured"
            )
        return value
    raise PluginPolicyError(f"unsupported profile setting {key}")


def validate_settings_proposal(
    settings: Mapping[str, Any],
    *,
    source: str,
) -> SettingsProposal:
    if not isinstance(settings, Mapping):
        raise PluginPolicyError("workflow/profile settings must be an object")
    forbidden = sorted(set(settings) & FORBIDDEN_SETTING_KEYS)
    if forbidden:
        raise PluginPolicyError(
            "plugin proposal cannot alter protected setting(s): "
            + ", ".join(forbidden)
        )
    unknown = sorted(set(settings) - PROFILE_SETTING_KEYS)
    if unknown:
        raise PluginPolicyError(
            "plugin proposal has unsupported setting(s): " + ", ".join(unknown)
        )
    patch = {
        key: _normalize_profile_value(key, value)
        for key, value in settings.items()
    }
    # Route ownership must stay unambiguous. A workflow profile may ask for
    # workflow or team routing, never both at once.
    if patch.get("workflowMode") in {"auto", "on"} and int(patch.get("team", 1)) > 1:
        raise PluginPolicyError(
            "a plugin profile cannot enable dynamic workflow and team > 1 together"
        )
    if patch.get("workflowMode") in {"auto", "on"}:
        patch.setdefault("a2aAgents", -1)
        patch.setdefault("a2aExecution", "terminal")
        patch.setdefault("terminalLayout", "auto")
        patch.setdefault("autoTeam", False)
        patch.setdefault("team", 1)
    return SettingsProposal(patch=patch, source=source)
