# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Strict, import-safe parser for the Sophia plugin manifest v1 contract.

Plugins are data until the registry and policy layers explicitly authorize
them.  This module never imports plugin code and rejects unknown manifest
fields so a typo cannot silently widen a plugin's authority.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from agent.plugin_integrity import (
    DirectoryMemberSnapshot,
    PluginIntegrityError,
    read_directory_snapshot_secure,
)

SCHEMA_VERSION = "sophia.plugin/v1"
PLUGIN_API_VERSION = "1"
MANIFEST_FILENAME = "sophia-plugin.json"

PLUGIN_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_PLUGIN_PACKAGE_FILES = 4096
MAX_PLUGIN_PACKAGE_BYTES = 67_108_864
DEFAULT_PLUGIN_MAX_OUTPUT_BYTES = 8_388_608
MAX_PLUGIN_OUTPUT_BYTES = 67_108_864
MAX_PLUGIN_CONCURRENCY = 64
MAX_PLUGIN_DEADLINE_SECONDS = 86_400

PLUGIN_KINDS = frozenset(
    {
        "skill-pack",
        "agent-pack",
        "workflow-pack",
        "capability-plugin",
        "runtime-adapter",
        "bundle",
    }
)
RUNTIME_ADAPTERS = frozenset({"deepseek-harness-headless", "jsonrpc-stdio"})
CONTRIBUTION_KEYS = frozenset(
    {"skills", "agents", "workflows", "profiles", "runtimes"}
)


class PluginManifestError(ValueError):
    """Raised when a manifest fails the public v1 contract."""


@dataclass(frozen=True)
class PluginSandboxPolicy:
    mode: str = "off"
    provider: str = "auto"
    filesystem: str = "plugin-only"
    network: str = "deny"
    processes: str = "deny-children"

    @property
    def required(self) -> bool:
        return self.mode == "required"

    @property
    def requested(self) -> bool:
        return self.mode in {"optional", "required"}


@dataclass(frozen=True)
class PluginResourceBudget:
    deadline_seconds: float = 3600.0
    max_output_bytes: int = DEFAULT_PLUGIN_MAX_OUTPUT_BYTES
    max_concurrency: int = 4


@dataclass(frozen=True)
class Entrypoint:
    transport: str
    rpc_version: str
    command: tuple[str, ...]
    cwd: str | None
    env_allow: tuple[str, ...]
    timeout_seconds: float
    sandbox: PluginSandboxPolicy = PluginSandboxPolicy()
    resources: PluginResourceBudget = PluginResourceBudget()


@dataclass(frozen=True)
class PluginManifest:
    schema_version: str
    api_version: str
    plugin_id: str
    name: str
    version: str
    description: str
    publisher: str
    kind: str
    trust_tier: int
    permissions: tuple[str, ...]
    contributes: Mapping[str, tuple[Mapping[str, Any], ...]]
    compatibility: Mapping[str, Any]
    entrypoint: Entrypoint | None
    candidate_only: bool
    can_claim_agi: bool
    manifest_path: Path
    plugin_root: Path
    digest: str

    @property
    def executable(self) -> bool:
        if self.entrypoint is not None:
            return True
        return any(
            str(runtime.get("adapter") or "") in RUNTIME_ADAPTERS
            for runtime in self.contributes.get("runtimes", ())
        )

    def contribution(self, kind: str, contribution_id: str) -> Mapping[str, Any] | None:
        for item in self.contributes.get(kind, ()):
            if item.get("id") == contribution_id:
                return item
        return None


def _expect_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PluginManifestError(f"{label} must be an object")
    return dict(value)


def _expect_string(
    value: Any,
    label: str,
    *,
    required: bool = True,
    maximum: int = 4096,
) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise PluginManifestError(f"{label} must be a non-empty string")
    text = value.strip()
    if len(text) > maximum:
        raise PluginManifestError(f"{label} exceeds {maximum} characters")
    return text


def _reject_unknown(obj: Mapping[str, Any], allowed: set[str] | frozenset[str], label: str) -> None:
    unknown = sorted(set(obj) - set(allowed))
    if unknown:
        raise PluginManifestError(f"{label} has unknown field(s): {', '.join(unknown)}")


def _string_list(value: Any, label: str, *, maximum: int = 64) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise PluginManifestError(f"{label} must be an array of strings")
    if len(value) > maximum:
        raise PluginManifestError(f"{label} exceeds {maximum} entries")
    out: list[str] = []
    for index, item in enumerate(value):
        text = _expect_string(item, f"{label}[{index}]", maximum=256)
        if text not in out:
            out.append(text)
    return tuple(out)


def _env_name_list(value: Any, label: str) -> tuple[str, ...]:
    names = _string_list(value, label)
    invalid = [name for name in names if not ENV_NAME_RE.fullmatch(name)]
    if invalid:
        raise PluginManifestError(
            f"{label} contains invalid environment variable name(s): "
            + ", ".join(invalid)
        )
    return names


def _strict_integer(
    value: Any,
    label: str,
    *,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PluginManifestError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise PluginManifestError(
            f"{label} must be between {minimum} and {maximum}"
        )
    return value


def _parse_sandbox(value: Any) -> PluginSandboxPolicy:
    if value is None:
        return PluginSandboxPolicy()
    raw = _expect_object(value, "entrypoint.sandbox")
    _reject_unknown(
        raw,
        {
            "mode",
            "provider",
            "filesystem",
            "network",
            "processes",
        },
        "entrypoint.sandbox",
    )
    mode = _expect_string(
        raw.get("mode", "off"),
        "entrypoint.sandbox.mode",
        maximum=16,
    )
    if mode not in {"off", "optional", "required"}:
        raise PluginManifestError(
            "entrypoint.sandbox.mode must be off, optional, or required"
        )
    provider = _expect_string(
        raw.get("provider", "auto"),
        "entrypoint.sandbox.provider",
        maximum=32,
    )
    if provider not in {"auto", "seatbelt", "bubblewrap"}:
        raise PluginManifestError(
            "entrypoint.sandbox.provider must be auto, seatbelt, or bubblewrap"
        )
    filesystem = _expect_string(
        raw.get("filesystem", "plugin-only"),
        "entrypoint.sandbox.filesystem",
        maximum=32,
    )
    if filesystem not in {
        "plugin-only",
        "workspace-read",
        "workspace-write",
    }:
        raise PluginManifestError(
            "entrypoint.sandbox.filesystem must be plugin-only, "
            "workspace-read, or workspace-write"
        )
    network = _expect_string(
        raw.get("network", "deny"),
        "entrypoint.sandbox.network",
        maximum=16,
    )
    if network not in {"deny", "allow"}:
        raise PluginManifestError(
            "entrypoint.sandbox.network must be deny or allow"
        )
    processes = _expect_string(
        raw.get("processes", "deny-children"),
        "entrypoint.sandbox.processes",
        maximum=32,
    )
    if processes not in {"deny-children", "isolated-tree"}:
        raise PluginManifestError(
            "entrypoint.sandbox.processes must be deny-children or isolated-tree"
        )
    if mode == "off" and (
        provider != "auto"
        or filesystem != "plugin-only"
        or network != "deny"
        or processes != "deny-children"
    ):
        raise PluginManifestError(
            "entrypoint.sandbox mode off cannot carry ignored capability settings"
        )
    return PluginSandboxPolicy(
        mode=mode,
        provider=provider,
        filesystem=filesystem,
        network=network,
        processes=processes,
    )


def _parse_resources(
    value: Any,
    *,
    rpc_version: str,
    timeout_seconds: float,
) -> PluginResourceBudget:
    raw = (
        {}
        if value is None
        else _expect_object(value, "entrypoint.resources")
    )
    _reject_unknown(
        raw,
        {
            "deadlineSeconds",
            "maxOutputBytes",
            "maxConcurrency",
        },
        "entrypoint.resources",
    )
    deadline = raw.get(
        "deadlineSeconds",
        max(3600.0, timeout_seconds),
    )
    if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
        raise PluginManifestError(
            "entrypoint.resources.deadlineSeconds must be numeric"
        )
    deadline_seconds = float(deadline)
    if not 1 <= deadline_seconds <= MAX_PLUGIN_DEADLINE_SECONDS:
        raise PluginManifestError(
            "entrypoint.resources.deadlineSeconds must be between 1 and 86400"
        )
    if deadline_seconds < timeout_seconds:
        raise PluginManifestError(
            "entrypoint.resources.deadlineSeconds cannot be less than "
            "entrypoint.timeoutSeconds"
        )
    max_output_bytes = _strict_integer(
        raw.get("maxOutputBytes", DEFAULT_PLUGIN_MAX_OUTPUT_BYTES),
        "entrypoint.resources.maxOutputBytes",
        minimum=1024,
        maximum=MAX_PLUGIN_OUTPUT_BYTES,
    )
    max_concurrency = _strict_integer(
        raw.get("maxConcurrency", 1 if rpc_version == "1" else 4),
        "entrypoint.resources.maxConcurrency",
        minimum=1,
        maximum=MAX_PLUGIN_CONCURRENCY,
    )
    if rpc_version == "1" and max_concurrency != 1:
        raise PluginManifestError(
            "entrypoint.resources.maxConcurrency must be 1 for RPC v1"
        )
    return PluginResourceBudget(
        deadline_seconds=deadline_seconds,
        max_output_bytes=max_output_bytes,
        max_concurrency=max_concurrency,
    )


def _parse_entrypoint(value: Any) -> Entrypoint | None:
    if value is None:
        return None
    raw = _expect_object(value, "entrypoint")
    _reject_unknown(
        raw,
        {
            "transport",
            "rpcVersion",
            "command",
            "cwd",
            "envAllow",
            "timeoutSeconds",
            "sandbox",
            "resources",
        },
        "entrypoint",
    )
    transport = _expect_string(raw.get("transport"), "entrypoint.transport", maximum=64)
    if transport != "jsonrpc-stdio":
        raise PluginManifestError("entrypoint.transport must be jsonrpc-stdio")
    rpc_version = _expect_string(
        raw.get("rpcVersion", "1"),
        "entrypoint.rpcVersion",
        maximum=8,
    )
    if rpc_version not in {"1", "2"}:
        raise PluginManifestError("entrypoint.rpcVersion must be 1 or 2")
    command = _string_list(raw.get("command"), "entrypoint.command", maximum=32)
    if not command:
        raise PluginManifestError("entrypoint.command must not be empty")
    if any("${" in item.replace("${pluginRoot}", "") for item in command):
        raise PluginManifestError(
            "entrypoint.command contains an unsupported placeholder"
        )
    if not any(
        item == "${pluginRoot}" or item.startswith("${pluginRoot}/")
        for item in command
    ):
        raise PluginManifestError(
            "entrypoint.command must reference a package-local ${pluginRoot} file"
        )
    cwd = raw.get("cwd")
    if cwd is not None:
        cwd = _expect_string(cwd, "entrypoint.cwd", maximum=512)
        if Path(cwd).is_absolute() or ".." in Path(cwd).parts:
            raise PluginManifestError("entrypoint.cwd must stay under the plugin root")
    timeout = raw.get("timeoutSeconds", 120)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise PluginManifestError("entrypoint.timeoutSeconds must be numeric")
    timeout_seconds = float(timeout)
    if not 1 <= timeout_seconds <= 3600:
        raise PluginManifestError("entrypoint.timeoutSeconds must be between 1 and 3600")
    sandbox = _parse_sandbox(raw.get("sandbox"))
    resources = _parse_resources(
        raw.get("resources"),
        rpc_version=rpc_version,
        timeout_seconds=timeout_seconds,
    )
    return Entrypoint(
        transport=transport,
        rpc_version=rpc_version,
        command=command,
        cwd=cwd,
        env_allow=_env_name_list(raw.get("envAllow"), "entrypoint.envAllow"),
        timeout_seconds=timeout_seconds,
        sandbox=sandbox,
        resources=resources,
    )


_CONTRIBUTION_FIELDS: dict[str, frozenset[str]] = {
    "skills": frozenset(
        {"id", "name", "description", "whenToUse", "instructions", "allowedTools"}
    ),
    "agents": frozenset(
        {"id", "name", "description", "role", "instructions", "allowedTools"}
    ),
    "workflows": frozenset(
        {
            "id",
            "name",
            "description",
            "settings",
            "stages",
            "proposalMethod",
        }
    ),
    "profiles": frozenset(
        {"id", "name", "description", "settings", "skill", "agent", "runtime"}
    ),
    "runtimes": frozenset(
        {
            "id",
            "name",
            "description",
            "adapter",
            "profile",
            "command",
            "method",
            "timeoutSeconds",
            "permissionMode",
            "envAllow",
        }
    ),
}


def _parse_contribution(kind: str, value: Any, index: int) -> Mapping[str, Any]:
    label = f"contributes.{kind}[{index}]"
    item = _expect_object(value, label)
    _reject_unknown(item, _CONTRIBUTION_FIELDS[kind], label)
    contribution_id = _expect_string(item.get("id"), f"{label}.id", maximum=96)
    if not PLUGIN_ID_RE.fullmatch(contribution_id):
        raise PluginManifestError(f"{label}.id is not a valid contribution id")
    item["id"] = contribution_id
    item["name"] = _expect_string(item.get("name"), f"{label}.name", maximum=120)
    if "description" in item:
        item["description"] = _expect_string(
            item.get("description"), f"{label}.description", required=False, maximum=1000
        )
    if kind in {"skills", "agents"}:
        instructions = _expect_string(
            item.get("instructions"), f"{label}.instructions", maximum=16_000
        )
        item["instructions"] = instructions
        item["allowedTools"] = list(
            _string_list(item.get("allowedTools"), f"{label}.allowedTools")
        )
        invalid_tools = [
            tool
            for tool in item["allowedTools"]
            if not PLUGIN_ID_RE.fullmatch(tool)
        ]
        if invalid_tools:
            raise PluginManifestError(
                f"{label}.allowedTools contains invalid tool id(s): "
                + ", ".join(invalid_tools)
            )
        if kind == "skills" and "whenToUse" in item:
            item["whenToUse"] = _expect_string(
                item.get("whenToUse"), f"{label}.whenToUse", maximum=1000
            )
        if kind == "agents" and "role" in item:
            item["role"] = _expect_string(item.get("role"), f"{label}.role", maximum=200)
    elif kind in {"workflows", "profiles"}:
        settings = item.get("settings", {})
        item["settings"] = _expect_object(settings, f"{label}.settings")
        try:
            from agent.plugin_policy import (
                PluginPolicyError,
                validate_settings_proposal,
            )

            item["settings"] = dict(
                validate_settings_proposal(
                    item["settings"],
                    source=label,
                ).patch
            )
        except PluginPolicyError as exc:
            raise PluginManifestError(str(exc)) from exc
        if kind == "workflows" and "stages" in item:
            if not isinstance(item["stages"], list) or len(item["stages"]) > 12:
                raise PluginManifestError(f"{label}.stages must be an array with at most 12 entries")
        if kind == "workflows" and "proposalMethod" in item:
            item["proposalMethod"] = _expect_string(
                item.get("proposalMethod"),
                f"{label}.proposalMethod",
                maximum=96,
            )
            if item["proposalMethod"] != "workflow.propose":
                raise PluginManifestError(
                    f"{label}.proposalMethod must be workflow.propose"
                )
            if item["settings"]:
                raise PluginManifestError(
                    f"{label}.settings must be empty when proposalMethod is used"
                )
        if kind == "profiles":
            for ref in ("skill", "agent", "runtime"):
                if ref in item:
                    item[ref] = _expect_string(
                        item.get(ref), f"{label}.{ref}", maximum=192
                    )
    elif kind == "runtimes":
        adapter = _expect_string(item.get("adapter"), f"{label}.adapter", maximum=64)
        if adapter not in RUNTIME_ADAPTERS:
            raise PluginManifestError(
                f"{label}.adapter must be one of: {', '.join(sorted(RUNTIME_ADAPTERS))}"
            )
        item["adapter"] = adapter
        if "command" in item:
            item["command"] = list(
                _string_list(item.get("command"), f"{label}.command", maximum=32)
            )
        if "envAllow" in item:
            item["envAllow"] = list(
                _env_name_list(item.get("envAllow"), f"{label}.envAllow")
            )
        timeout = item.get("timeoutSeconds", 900)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise PluginManifestError(f"{label}.timeoutSeconds must be numeric")
        item["timeoutSeconds"] = float(timeout)
        if not 1 <= item["timeoutSeconds"] <= 3600:
            raise PluginManifestError(
                f"{label}.timeoutSeconds must be between 1 and 3600"
            )
        if adapter == "deepseek-harness-headless":
            unsupported = sorted(
                field
                for field in ("method",)
                if field in item
            )
            if unsupported:
                raise PluginManifestError(
                    f"{label} has field(s) unsupported by {adapter}: "
                    + ", ".join(unsupported)
                )
            command = item.get("command") or ["dsh"]
            if Path(str(command[0])).name != "dsh":
                raise PluginManifestError(
                    f"{label}.command must invoke the dsh executable"
                )
            item["profile"] = _expect_string(
                item.get("profile", "headless"), f"{label}.profile", maximum=64
            )
            if item["profile"] != "headless":
                raise PluginManifestError(
                    f"{label}.profile must be headless in plugin ABI v1"
                )
            item["permissionMode"] = _expect_string(
                item.get("permissionMode", "read-only"),
                f"{label}.permissionMode",
                maximum=64,
            )
            if item["permissionMode"] != "read-only":
                raise PluginManifestError(
                    f"{label}.permissionMode must be read-only in plugin ABI v1"
                )
        elif adapter == "jsonrpc-stdio":
            unsupported = sorted(
                field
                for field in (
                    "profile",
                    "command",
                    "permissionMode",
                    "envAllow",
                )
                if field in item
            )
            if unsupported:
                raise PluginManifestError(
                    f"{label} has field(s) unsupported by {adapter}: "
                    + ", ".join(unsupported)
                )
            item["method"] = _expect_string(
                item.get("method", "runtime.execute"), f"{label}.method", maximum=96
            )
            if item["method"] != "runtime.execute":
                raise PluginManifestError(
                    f"{label}.method must be runtime.execute in plugin ABI v1"
                )
    return item


def _parse_contributes(value: Any) -> Mapping[str, tuple[Mapping[str, Any], ...]]:
    raw = _expect_object(value or {}, "contributes")
    _reject_unknown(raw, CONTRIBUTION_KEYS, "contributes")
    out: dict[str, tuple[Mapping[str, Any], ...]] = {}
    seen: set[tuple[str, str]] = set()
    for kind in sorted(CONTRIBUTION_KEYS):
        values = raw.get(kind, [])
        if not isinstance(values, list):
            raise PluginManifestError(f"contributes.{kind} must be an array")
        if len(values) > 128:
            raise PluginManifestError(f"contributes.{kind} exceeds 128 entries")
        parsed: list[Mapping[str, Any]] = []
        for index, value_item in enumerate(values):
            item = _parse_contribution(kind, value_item, index)
            identity = (kind, str(item["id"]))
            if identity in seen:
                raise PluginManifestError(
                    f"duplicate contribution {kind}/{item['id']}"
                )
            seen.add(identity)
            parsed.append(item)
        out[kind] = tuple(parsed)
    return out


def _absolute_without_resolving(path: str | Path) -> Path:
    return Path(os.path.abspath(Path(path).expanduser()))


def _read_package_snapshot(
    plugin_root: str | Path,
) -> dict[str, DirectoryMemberSnapshot]:
    try:
        return read_directory_snapshot_secure(
            _absolute_without_resolving(plugin_root),
            max_files=MAX_PLUGIN_PACKAGE_FILES,
            max_bytes=MAX_PLUGIN_PACKAGE_BYTES,
            max_file_bytes=MAX_PLUGIN_PACKAGE_BYTES,
        )
    except PluginIntegrityError as exc:
        raise PluginManifestError(str(exc)) from exc


def _package_snapshot_digest(
    snapshot: Mapping[str, DirectoryMemberSnapshot],
) -> str:
    digest = hashlib.sha256()
    for relative, member in sorted(snapshot.items()):
        relative_bytes = relative.encode("utf-8")
        digest.update(len(relative_bytes).to_bytes(4, "big"))
        digest.update(relative_bytes)
        digest.update(member.mode.to_bytes(2, "big"))
        digest.update(len(member.content).to_bytes(8, "big"))
        digest.update(member.content)
    return "sha256:" + digest.hexdigest()


def plugin_package_digest(plugin_root: str | Path) -> str:
    """Hash one immutable, no-follow snapshot of the local plugin package."""
    return _package_snapshot_digest(_read_package_snapshot(plugin_root))


def load_manifest(path: str | Path) -> PluginManifest:
    manifest_path = _absolute_without_resolving(path)
    if manifest_path.name != MANIFEST_FILENAME:
        raise PluginManifestError(f"manifest must be named {MANIFEST_FILENAME}")
    snapshot = _read_package_snapshot(manifest_path.parent)
    manifest_member = snapshot.get(MANIFEST_FILENAME)
    if manifest_member is None:
        raise PluginManifestError("plugin package has no manifest")
    raw_bytes = manifest_member.content
    if len(raw_bytes) > 1_048_576:
        raise PluginManifestError("manifest exceeds 1 MiB")
    try:
        data = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PluginManifestError(
            f"manifest is not valid UTF-8 JSON: {type(exc).__name__}"
        ) from exc
    raw = _expect_object(data, "manifest")
    _reject_unknown(
        raw,
        {
            "schemaVersion",
            "apiVersion",
            "id",
            "name",
            "version",
            "description",
            "publisher",
            "kind",
            "trustTier",
            "permissions",
            "compatibility",
            "entrypoint",
            "contributes",
            "candidateOnly",
            "canClaimAGI",
        },
        "manifest",
    )
    schema_version = _expect_string(raw.get("schemaVersion"), "schemaVersion", maximum=64)
    if schema_version != SCHEMA_VERSION:
        raise PluginManifestError(f"schemaVersion must be {SCHEMA_VERSION}")
    api_version = _expect_string(raw.get("apiVersion"), "apiVersion", maximum=32)
    if api_version != PLUGIN_API_VERSION:
        raise PluginManifestError(f"apiVersion must be {PLUGIN_API_VERSION}")
    plugin_id = _expect_string(raw.get("id"), "id", maximum=96)
    if not PLUGIN_ID_RE.fullmatch(plugin_id):
        raise PluginManifestError("id must be lowercase and filesystem-safe")
    version = _expect_string(raw.get("version"), "version", maximum=64)
    if not VERSION_RE.fullmatch(version):
        raise PluginManifestError("version must be semver-shaped (for example 1.2.3)")
    kind = _expect_string(raw.get("kind"), "kind", maximum=64)
    if kind not in PLUGIN_KINDS:
        raise PluginManifestError(
            f"kind must be one of: {', '.join(sorted(PLUGIN_KINDS))}"
        )
    trust_tier = raw.get("trustTier")
    if isinstance(trust_tier, bool) or not isinstance(trust_tier, int):
        raise PluginManifestError("trustTier must be an integer from 0 to 5")
    if trust_tier < 0 or trust_tier > 5:
        raise PluginManifestError("trustTier must be an integer from 0 to 5")
    candidate_only = raw.get("candidateOnly")
    can_claim_agi = raw.get("canClaimAGI")
    if candidate_only is not True:
        raise PluginManifestError("candidateOnly must be true")
    if can_claim_agi is not False:
        raise PluginManifestError("canClaimAGI must be false")
    compatibility = _expect_object(raw.get("compatibility", {}), "compatibility")
    _reject_unknown(
        compatibility,
        {"sophiaApi", "platforms", "architectures"},
        "compatibility",
    )
    if compatibility.get("sophiaApi", PLUGIN_API_VERSION) != PLUGIN_API_VERSION:
        raise PluginManifestError(
            f"compatibility.sophiaApi must be {PLUGIN_API_VERSION}"
        )
    compatibility["sophiaApi"] = PLUGIN_API_VERSION
    compatibility["platforms"] = list(
        _string_list(
            compatibility.get("platforms"),
            "compatibility.platforms",
            maximum=16,
        )
    )
    compatibility["architectures"] = list(
        _string_list(
            compatibility.get("architectures"),
            "compatibility.architectures",
            maximum=16,
        )
    )
    contributes = _parse_contributes(raw.get("contributes"))
    entrypoint = _parse_entrypoint(raw.get("entrypoint"))
    if entrypoint is None and not any(contributes.values()):
        raise PluginManifestError("manifest must declare at least one contribution")
    package_digest = _package_snapshot_digest(snapshot)
    manifest = PluginManifest(
        schema_version=schema_version,
        api_version=api_version,
        plugin_id=plugin_id,
        name=_expect_string(raw.get("name"), "name", maximum=120),
        version=version,
        description=_expect_string(
            raw.get("description"), "description", required=False, maximum=2000
        ),
        publisher=_expect_string(raw.get("publisher"), "publisher", maximum=120),
        kind=kind,
        trust_tier=trust_tier,
        permissions=_string_list(raw.get("permissions"), "permissions"),
        contributes=contributes,
        compatibility=compatibility,
        entrypoint=entrypoint,
        candidate_only=candidate_only,
        can_claim_agi=can_claim_agi,
        manifest_path=manifest_path,
        plugin_root=manifest_path.parent,
        digest=package_digest,
    )
    if manifest.trust_tier in {0, 3}:
        raise PluginManifestError(
            f"trustTier {manifest.trust_tier} is reserved and unavailable in ABI v1"
        )
    if manifest.executable and manifest.trust_tier != 4:
        raise PluginManifestError(
            "executable plugins require supervised trustTier 4"
        )
    if not manifest.executable and manifest.trust_tier == 4:
        raise PluginManifestError(
            "trustTier 4 is reserved for supervised executable plugins"
        )
    if manifest.trust_tier == 5:
        raise PluginManifestError(
            "trustTier 5 unrestricted plugins are reserved and rejected by ABI v1"
        )
    required_permissions: set[str] = set()
    if manifest.contributes.get("skills"):
        required_permissions.add("skill.provide")
    if manifest.contributes.get("agents"):
        required_permissions.add("agent.provide")
    if manifest.contributes.get("workflows") or manifest.contributes.get("profiles"):
        required_permissions.add("workflow.propose")
    runtimes = manifest.contributes.get("runtimes", ())
    if runtimes:
        required_permissions.update({"runtime.execute", "process.spawn"})
    if any(
        str(runtime.get("adapter") or "") == "deepseek-harness-headless"
        for runtime in runtimes
    ):
        required_permissions.add("filesystem.read")
    if manifest.entrypoint is not None:
        required_permissions.add("process.spawn")
        if manifest.kind == "capability-plugin":
            # Capability sidecars are invoked through supervised RPC even when
            # they intentionally expose no selectable runtime contribution.
            # Their host call path still requires explicit runtime authority.
            required_permissions.add("runtime.execute")
    sandbox_policy = (
        manifest.entrypoint.sandbox
        if manifest.entrypoint is not None
        else PluginSandboxPolicy()
    )
    has_unsandboxed_fallback = (
        manifest.entrypoint is None
        or sandbox_policy.mode in {"off", "optional"}
    )
    if manifest.executable and has_unsandboxed_fallback:
        required_permissions.update(
            {
                "filesystem.read",
                "filesystem.write",
                "network.access",
            }
        )
    elif manifest.executable:
        if sandbox_policy.filesystem in {
            "workspace-read",
            "workspace-write",
        }:
            required_permissions.add("filesystem.read")
        if sandbox_policy.filesystem == "workspace-write":
            required_permissions.add("filesystem.write")
        if sandbox_policy.network == "allow":
            required_permissions.add("network.access")
    if (
        (manifest.entrypoint is not None and manifest.entrypoint.env_allow)
        or any(runtime.get("envAllow") for runtime in runtimes)
    ):
        required_permissions.add("environment.read")
    missing_permissions = sorted(required_permissions - set(manifest.permissions))
    if missing_permissions:
        raise PluginManifestError(
            "manifest contribution(s) require permission(s): "
            + ", ".join(missing_permissions)
        )
    unused_permissions = sorted(set(manifest.permissions) - required_permissions)
    if unused_permissions:
        raise PluginManifestError(
            "manifest declares permission(s) without a matching contribution: "
            + ", ".join(unused_permissions)
        )
    has_jsonrpc_runtime = any(
        str(runtime.get("adapter") or "") == "jsonrpc-stdio"
        for runtime in runtimes
    )
    has_dynamic_workflow = any(
        str(workflow.get("proposalMethod") or "") == "workflow.propose"
        for workflow in manifest.contributes.get("workflows", ())
    )
    if has_jsonrpc_runtime and manifest.entrypoint is None:
        raise PluginManifestError(
            "jsonrpc-stdio runtime contributions require an entrypoint"
        )
    if has_dynamic_workflow and manifest.entrypoint is None:
        raise PluginManifestError(
            "dynamic workflow contributions require a JSON-RPC entrypoint"
        )
    if (
        manifest.entrypoint is not None
        and not has_jsonrpc_runtime
        and not has_dynamic_workflow
        and manifest.kind != "capability-plugin"
    ):
        raise PluginManifestError(
            "entrypoint requires a jsonrpc-stdio runtime or dynamic workflow"
        )
    return manifest


def manifest_public_dict(manifest: PluginManifest) -> dict[str, Any]:
    """Return non-secret manifest metadata suitable for the TUI protocol."""
    return {
        "id": manifest.plugin_id,
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
        "publisher": manifest.publisher,
        "kind": manifest.kind,
        "trustTier": manifest.trust_tier,
        "permissions": list(manifest.permissions),
        "contributionCounts": {
            key: len(value)
            for key, value in manifest.contributes.items()
            if value
        },
        "rpcVersion": (
            manifest.entrypoint.rpc_version
            if manifest.entrypoint is not None
            else None
        ),
        "sandbox": (
            {
                "mode": manifest.entrypoint.sandbox.mode,
                "provider": manifest.entrypoint.sandbox.provider,
                "filesystem": manifest.entrypoint.sandbox.filesystem,
                "network": manifest.entrypoint.sandbox.network,
                "processes": manifest.entrypoint.sandbox.processes,
            }
            if manifest.entrypoint is not None
            else None
        ),
        "resources": (
            {
                "deadlineSeconds": (
                    manifest.entrypoint.resources.deadline_seconds
                ),
                "maxOutputBytes": (
                    manifest.entrypoint.resources.max_output_bytes
                ),
                "maxConcurrency": (
                    manifest.entrypoint.resources.max_concurrency
                ),
            }
            if manifest.entrypoint is not None
            else None
        ),
        "executable": manifest.executable,
        "digest": manifest.digest,
        "candidateOnly": True,
        "canClaimAGI": False,
    }
