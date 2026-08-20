# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""JSON-RPC 2.0 envelopes for supervised Sophia plugin sidecars."""
from __future__ import annotations

from dataclasses import dataclass
import math
from types import MappingProxyType
from typing import Any, Mapping

JSONRPC_VERSION = "2.0"
MAX_MESSAGE_BYTES = 1_048_576
SAFE_INTEGER_MAX = 9_007_199_254_740_991
SUPPORTED_API_VERSIONS = frozenset({"1", "2"})
PREFERRED_API_VERSION = "2"

V1_REQUEST_METHODS = frozenset(
    {
        "initialize",
        "health",
        "runtime.execute",
        "workflow.propose",
        "shutdown",
    }
)
V1_NOTIFICATION_METHODS = frozenset({"runtime.progress"})
V2_REQUEST_METHODS = frozenset(
    {
        "initialize",
        "health",
        "catalog.list",
        "runtime.execute",
        "tool.list",
        "tool.execute",
        "tool.cancel",
        "command.list",
        "command.execute",
        "skill.list",
        "skill.read",
        "workflow.list",
        "workflow.start",
        "workflow.status",
        "workflow.cancel",
        "job.list",
        "job.status",
        "job.cancel",
        "artifact.read",
        "shutdown",
    }
)
V2_NOTIFICATION_METHODS = frozenset(
    {
        "catalog.changed",
        "execution.progress",
        "execution.event",
    }
)
REQUEST_METHODS_BY_VERSION = MappingProxyType(
    {
        "1": V1_REQUEST_METHODS,
        "2": V2_REQUEST_METHODS,
    }
)
NOTIFICATION_METHODS_BY_VERSION = MappingProxyType(
    {
        "1": V1_NOTIFICATION_METHODS,
        "2": V2_NOTIFICATION_METHODS,
    }
)
# Compatibility/export surface for callers that enumerate every public method.
PUBLIC_REQUEST_METHODS = V1_REQUEST_METHODS | V2_REQUEST_METHODS
PUBLIC_NOTIFICATION_METHODS = V1_NOTIFICATION_METHODS | V2_NOTIFICATION_METHODS
# Compatibility/export surface for callers that need to enumerate the complete
# public ABI. Envelope builders still validate the method against its direction.
PUBLIC_METHODS = PUBLIC_REQUEST_METHODS | PUBLIC_NOTIFICATION_METHODS


class PluginProtocolError(ValueError):
    """Raised for malformed or unauthorized JSON-RPC messages."""


class PluginRpcError(PluginProtocolError):
    """Raised for a well-formed JSON-RPC error returned by a plugin."""

    def __init__(self, error: "JsonRpcError"):
        super().__init__(error.message)
        self.error = error


@dataclass(frozen=True)
class JsonRpcError:
    code: int
    message: str
    data: Any = None


def _validate_request_id(
    value: Any,
    *,
    label: str = "JSON-RPC id",
) -> str | int:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise PluginProtocolError(
            f"{label} must be a safe integer or non-empty string"
        )
    if isinstance(value, int) and not -SAFE_INTEGER_MAX <= value <= SAFE_INTEGER_MAX:
        raise PluginProtocolError(
            f"{label} integer must be within the interoperable safe range"
        )
    if isinstance(value, str) and not 1 <= len(value) <= 128:
        raise PluginProtocolError(
            f"{label} string must contain 1 to 128 characters"
        )
    return value


def _validate_json_value(
    value: Any,
    *,
    label: str,
    depth: int = 0,
) -> None:
    if depth > 64:
        raise PluginProtocolError(f"{label} exceeded maximum nesting depth")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        if not -SAFE_INTEGER_MAX <= value <= SAFE_INTEGER_MAX:
            raise PluginProtocolError(
                f"{label} integer exceeded the interoperable safe range"
            )
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PluginProtocolError(f"{label} contained NaN or Infinity")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json_value(item, label=label, depth=depth + 1)
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise PluginProtocolError(
                    f"{label} object keys must be strings"
                )
            _validate_json_value(item, label=label, depth=depth + 1)
        return
    raise PluginProtocolError(f"{label} contained a non-JSON value")


def normalize_api_version(api_version: str | int) -> str:
    if isinstance(api_version, bool):
        raise PluginProtocolError("plugin API version must be 1 or 2")
    version = str(api_version)
    if version not in SUPPORTED_API_VERSIONS:
        raise PluginProtocolError("plugin API version must be 1 or 2")
    return version


def request_methods(api_version: str | int) -> frozenset[str]:
    return REQUEST_METHODS_BY_VERSION[normalize_api_version(api_version)]


def notification_methods(api_version: str | int) -> frozenset[str]:
    return NOTIFICATION_METHODS_BY_VERSION[normalize_api_version(api_version)]


def request(
    request_id: str | int,
    method: str,
    params: Mapping[str, Any] | None = None,
    *,
    api_version: str | int = "1",
) -> dict[str, Any]:
    version = normalize_api_version(api_version)
    _validate_request_id(request_id)
    if method not in REQUEST_METHODS_BY_VERSION[version]:
        raise PluginProtocolError(
            f"method is not a Sophia plugin request for API v{version}: {method}"
        )
    normalized_params = dict(params or {})
    _validate_json_value(normalized_params, label=f"{method} params")
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": request_id,
        "method": method,
        "params": normalized_params,
    }


def notification(
    method: str,
    params: Mapping[str, Any] | None = None,
    *,
    api_version: str | int = "1",
) -> dict[str, Any]:
    version = normalize_api_version(api_version)
    if method not in NOTIFICATION_METHODS_BY_VERSION[version]:
        raise PluginProtocolError(
            "method is not a Sophia plugin notification "
            f"for API v{version}: {method}"
        )
    normalized_params = dict(params or {})
    _validate_json_value(normalized_params, label=f"{method} params")
    return {
        "jsonrpc": JSONRPC_VERSION,
        "method": method,
        "params": normalized_params,
    }


def execution_contract(
    *,
    isolation: Mapping[str, Any],
    deadline_seconds: float,
    max_output_bytes: int,
    max_concurrency: int,
    environment_allow: tuple[str, ...] | list[str],
) -> dict[str, Any]:
    """Build the secret-free execution limits disclosed during initialize."""
    if isinstance(deadline_seconds, bool) or not isinstance(
        deadline_seconds,
        (int, float),
    ):
        raise PluginProtocolError("execution deadline must be numeric")
    if deadline_seconds <= 0:
        raise PluginProtocolError("execution deadline must be positive")
    for value, label in (
        (max_output_bytes, "maxOutputBytes"),
        (max_concurrency, "maxConcurrency"),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise PluginProtocolError(
                f"execution {label} must be a positive integer"
            )
    names: list[str] = []
    for name in environment_allow:
        if not isinstance(name, str) or not name:
            raise PluginProtocolError(
                "execution environment allow-list must contain strings"
            )
        if name not in names:
            names.append(name)
    return {
        "isolation": dict(isolation),
        "resources": {
            "deadlineSeconds": float(deadline_seconds),
            "maxOutputBytes": max_output_bytes,
            "maxConcurrency": max_concurrency,
        },
        "environmentAllow": names,
    }


def parse_response(payload: Any, *, expected_id: str | int) -> Any:
    _validate_request_id(expected_id, label="expected JSON-RPC id")
    if not isinstance(payload, dict):
        raise PluginProtocolError("JSON-RPC response must be an object")
    if payload.get("jsonrpc") != JSONRPC_VERSION:
        raise PluginProtocolError("JSON-RPC response version mismatch")
    response_id = _validate_request_id(
        payload.get("id"),
        label="JSON-RPC response id",
    )
    if response_id != expected_id:
        raise PluginProtocolError("JSON-RPC response id mismatch")
    if "result" in payload and "error" in payload:
        raise PluginProtocolError("JSON-RPC response cannot contain result and error")
    if "error" in payload:
        if set(payload) != {"jsonrpc", "id", "error"}:
            raise PluginProtocolError(
                "JSON-RPC error response fields are invalid"
            )
        error = payload["error"]
        if not isinstance(error, dict):
            raise PluginProtocolError("JSON-RPC error must be an object")
        if not {"code", "message"} <= set(error) or set(error) - {
            "code",
            "message",
            "data",
        }:
            raise PluginProtocolError("JSON-RPC error fields are invalid")
        code = error.get("code")
        message = error.get("message")
        if (
            isinstance(code, bool)
            or not isinstance(code, int)
            or not -SAFE_INTEGER_MAX <= code <= SAFE_INTEGER_MAX
        ):
            raise PluginProtocolError(
                "JSON-RPC error code must be a safe integer"
            )
        if not isinstance(message, str) or not 1 <= len(message) <= 800:
            raise PluginProtocolError(
                "JSON-RPC error message must contain 1 to 800 characters"
            )
        data = error.get("data")
        _validate_json_value(data, label="JSON-RPC error data")
        raise PluginRpcError(
            JsonRpcError(
                code=code,
                message=message[:800],
                data=data,
            )
        )
    if "result" not in payload:
        raise PluginProtocolError("JSON-RPC response is missing result")
    if set(payload) != {"jsonrpc", "id", "result"}:
        raise PluginProtocolError(
            "JSON-RPC success response fields are invalid"
        )
    result = payload["result"]
    _validate_json_value(result, label="JSON-RPC result")
    return result
