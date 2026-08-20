#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Packaged bounded compatibility smoke for user-configured model endpoints.

This module is deliberately stdlib-only.  It can be imported by offline tests
or run as a CLI against an operator-approved endpoint.  The smoke never
discovers credentials from provider-specific defaults: an optional API key is
read only from the explicitly named environment variable.

The smoke validates transport compatibility; it is not a benchmark, security
certification, or model-capability claim.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable, Mapping, Sequence

from agent.secret_patterns import redact_diagnostic


SCHEMA = "sophia.custom-endpoint-smoke.v1"
PROTOCOLS = ("openai-chat", "openai-responses", "anthropic-messages")
DEFAULT_PROBES = ("discovery", "text", "tools", "response_format", "stream")
MAX_RESPONSE_BYTES = 1_048_576
MAX_MODELS = 256
MAX_TOOL_ARGUMENT_BYTES = 16_384
DEFAULT_TIMEOUT_SEC = 5.0

_ENV_NAME_RE = re.compile(r"[A-Z_][A-Z0-9_]{0,127}\Z")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_ENCODED_PATH_DELIMITER_RE = re.compile(r"%(?:2e|2f|5c)", re.IGNORECASE)
_HOSTNAME_RE = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z",
    re.IGNORECASE,
)
_METADATA_HOSTS = frozenset(
    {
        "metadata.google.internal",
        "metadata.google.internal.",
        "instance-data.ec2.internal",
        "instance-data.ec2.internal.",
    }
)
_METADATA_IPS = frozenset(
    {
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("169.254.170.2"),
        ipaddress.ip_address("100.100.100.200"),
        ipaddress.ip_address("fd00:ec2::254"),
    }
)

_SMOKE_TOOL_NAME = "endpoint_smoke"
_SMOKE_TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string", "enum": ["health"]}},
    "required": ["query"],
    "additionalProperties": False,
}
_SMOKE_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"status": {"type": "string", "enum": ["ok"]}},
    "required": ["status"],
    "additionalProperties": False,
}


class EndpointSafetyError(ValueError):
    """The endpoint cannot be contacted under the requested authority."""


class SmokeError(RuntimeError):
    """A typed compatibility-smoke failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        request_id: str | None = None,
        response_preview: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.response_preview = response_preview


class SmokeSkip(RuntimeError):
    """A protocol does not define the requested optional probe."""


@dataclass(frozen=True)
class EndpointTarget:
    canonical_url: str
    scheme: str
    host: str
    port: int
    base_path: str
    network_scope: str
    resolved_addresses: tuple[str, ...] = ()

    def public_dict(self) -> dict[str, Any]:
        """Return authority metadata only; credentials can never appear here."""
        return {
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "basePath": self.base_path,
            "networkScope": self.network_scope,
            "resolvedAddresses": list(self.resolved_addresses),
        }


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str
    latency_ms: int
    diagnostic_code: str | None = None
    message: str | None = None
    http_status: int | None = None
    request_id: str | None = None
    response_preview: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in asdict(self).items()
            if value is not None
        }


def _classify_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str:
    if address in _METADATA_IPS:
        return "metadata"
    if address.is_unspecified or address.is_multicast or address.is_reserved:
        return "forbidden"
    if address.is_loopback:
        return "loopback"
    if address.is_private or address.is_link_local:
        return "private"
    return "public"


def _literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _resolved_ips(
    host: str,
    port: int,
    resolver: Callable[..., Sequence[tuple[Any, ...]]],
) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
    try:
        records = resolver(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise EndpointSafetyError(f"endpoint DNS resolution failed: {exc}") from exc
    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for record in records:
        try:
            raw = record[4][0]
            address = ipaddress.ip_address(raw)
        except (IndexError, TypeError, ValueError):
            continue
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise EndpointSafetyError("endpoint DNS resolution returned no usable addresses")
    return tuple(addresses)


def validate_base_url(
    value: str,
    *,
    confirm_public_remote: bool = False,
    confirm_private_network: bool = False,
    resolver: Callable[..., Sequence[tuple[Any, ...]]] = socket.getaddrinfo,
) -> EndpointTarget:
    """Validate and classify one exact API prefix.

    Plain HTTP is accepted only for a literal loopback target or ``localhost``.
    Public remote and private-network targets require separate explicit flags.
    Known cloud-metadata authorities are always refused.
    """
    raw = (value or "").strip()
    if not raw or _CONTROL_RE.search(raw):
        raise EndpointSafetyError("base URL must be non-empty and contain no control characters")
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise EndpointSafetyError(f"invalid base URL authority: {exc}") from exc
    if parsed.scheme.casefold() not in {"http", "https"}:
        raise EndpointSafetyError("base URL scheme must be http or https")
    if not parsed.hostname:
        raise EndpointSafetyError("base URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise EndpointSafetyError("credentials in endpoint URLs are forbidden")
    if parsed.query or parsed.fragment:
        raise EndpointSafetyError("base URL must not contain a query string or fragment")
    if parsed.path and (
        "\\" in parsed.path
        or _ENCODED_PATH_DELIMITER_RE.search(parsed.path)
        or any(part in {".", ".."} for part in urllib.parse.unquote(parsed.path).split("/"))
    ):
        raise EndpointSafetyError("base URL path contains an ambiguous or traversing segment")

    scheme = parsed.scheme.casefold()
    host = parsed.hostname.casefold().rstrip(".")
    if host in {name.rstrip(".") for name in _METADATA_HOSTS}:
        raise EndpointSafetyError("cloud metadata endpoints are forbidden")
    if _literal_ip(host) is None:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise EndpointSafetyError("endpoint hostname is not valid IDNA") from exc
        if not _HOSTNAME_RE.fullmatch(host):
            raise EndpointSafetyError("endpoint hostname is malformed")
    port = port or (443 if scheme == "https" else 80)
    if not 1 <= port <= 65535:
        raise EndpointSafetyError("endpoint port must be between 1 and 65535")

    literal = _literal_ip(host)
    loopback_name = host == "localhost"
    if literal is not None:
        addresses = (literal,)
    elif loopback_name:
        addresses = (ipaddress.ip_address("127.0.0.1"),)
    else:
        addresses = _resolved_ips(host, port, resolver)

    classifications = {_classify_ip(address) for address in addresses}
    if "metadata" in classifications:
        raise EndpointSafetyError("cloud metadata endpoints are forbidden")
    if "forbidden" in classifications:
        raise EndpointSafetyError("unspecified, multicast, or reserved endpoint addresses are forbidden")
    if len(classifications) != 1:
        raise EndpointSafetyError(
            "endpoint DNS resolves across multiple network scopes; refusing ambiguous authority"
        )
    scope = next(iter(classifications))
    if not (literal is not None or loopback_name) and scope == "loopback":
        scope = "private"
    if scope == "public" and not confirm_public_remote:
        raise EndpointSafetyError("public remote endpoint requires explicit confirmation")
    if scope == "private" and not confirm_private_network:
        raise EndpointSafetyError("private-network endpoint requires explicit confirmation")
    if scheme == "http" and scope != "loopback":
        raise EndpointSafetyError("plain HTTP is allowed only for loopback endpoints")

    path = parsed.path.rstrip("/")
    host_for_url = f"[{host}]" if ":" in host else host
    default_port = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    authority = host_for_url if default_port else f"{host_for_url}:{port}"
    canonical = f"{scheme}://{authority}{path}"
    return EndpointTarget(
        canonical_url=canonical,
        scheme=scheme,
        host=host,
        port=port,
        base_path=path or "/",
        network_scope=scope,
        resolved_addresses=tuple(str(address) for address in addresses),
    )


def _resource_url(target: EndpointTarget, resource: str) -> str:
    return f"{target.canonical_url.rstrip('/')}/{resource.lstrip('/')}"


def _redact(text: str, secrets: Iterable[str]) -> str:
    return redact_diagnostic(text, secrets=secrets)


def _request_id(headers: Mapping[str, str]) -> str | None:
    lowered = {str(key).casefold(): str(value) for key, value in headers.items()}
    for name in ("x-request-id", "request-id", "trace-id", "cf-ray"):
        value = lowered.get(name)
        if value:
            return value[:160]
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class EndpointHttpClient:
    """Small no-redirect JSON/SSE client with bounded response reads."""

    def __init__(
        self,
        target: EndpointTarget,
        *,
        protocol: str,
        credential: str | None,
        timeout_sec: float,
        ssl_context: ssl.SSLContext | None = None,
        use_environment_proxy: bool = False,
    ) -> None:
        if protocol not in PROTOCOLS:
            raise ValueError(f"unsupported protocol {protocol!r}")
        self.target = target
        self.protocol = protocol
        self.credential = credential or ""
        self.timeout_sec = timeout_sec
        handlers: list[Any] = [_NoRedirect()]
        if not use_environment_proxy:
            handlers.append(urllib.request.ProxyHandler({}))
        if target.scheme == "https":
            handlers.append(
                urllib.request.HTTPSHandler(
                    context=ssl_context or ssl.create_default_context()
                )
            )
        self._opener = urllib.request.build_opener(*handlers)

    def _headers(self, *, accept: str) -> dict[str, str]:
        headers = {
            "Accept": accept,
            "Content-Type": "application/json",
            "User-Agent": "Sophia-Custom-Endpoint-Smoke/1",
        }
        if self.credential:
            if self.protocol == "anthropic-messages":
                headers["x-api-key"] = self.credential
            else:
                headers["Authorization"] = f"Bearer {self.credential}"
        if self.protocol == "anthropic-messages":
            headers["anthropic-version"] = "2023-06-01"
        return headers

    def _open(
        self,
        method: str,
        resource: str,
        payload: Mapping[str, Any] | None,
        *,
        accept: str,
    ):
        data = (
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
            if payload is not None
            else None
        )
        request = urllib.request.Request(
            _resource_url(self.target, resource),
            data=data,
            method=method,
            headers=self._headers(accept=accept),
        )
        try:
            return self._opener.open(request, timeout=self.timeout_sec)
        except urllib.error.HTTPError as exc:
            raw = exc.read(MAX_RESPONSE_BYTES + 1)
            preview = _redact(
                raw[:512].decode("utf-8", errors="replace"),
                (self.credential,),
            )
            code = "redirect_refused" if 300 <= exc.code < 400 else "http_error"
            raise SmokeError(
                code,
                f"HTTP {exc.code} from endpoint",
                status=exc.code,
                request_id=_request_id(exc.headers),
                response_preview=preview,
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SmokeError(
                "transport_error",
                _redact(f"endpoint request failed: {exc}", (self.credential,)),
            ) from exc

    @staticmethod
    def _read_bounded(response) -> bytes:  # noqa: ANN001
        declared = response.headers.get("Content-Length")
        if declared:
            try:
                if int(declared) > MAX_RESPONSE_BYTES:
                    raise SmokeError(
                        "response_too_large",
                        f"response Content-Length exceeds {MAX_RESPONSE_BYTES} bytes",
                    )
            except ValueError:
                pass
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise SmokeError(
                "response_too_large",
                f"response exceeded {MAX_RESPONSE_BYTES} bytes",
            )
        return raw

    def request_json(
        self,
        method: str,
        resource: str,
        payload: Mapping[str, Any] | None = None,
    ) -> Any:
        with self._open(method, resource, payload, accept="application/json") as response:
            content_type = (response.headers.get("Content-Type") or "").casefold()
            request_id = _request_id(response.headers)
            raw = self._read_bounded(response)
        if "json" not in content_type:
            raise SmokeError(
                "unexpected_content_type",
                f"expected JSON response, received {content_type or 'missing Content-Type'}",
                request_id=request_id,
                response_preview=_redact(
                    raw[:512].decode("utf-8", errors="replace"),
                    (self.credential,),
                ),
            )
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SmokeError(
                "malformed_json",
                f"endpoint returned malformed JSON: {exc}",
                request_id=request_id,
                response_preview=_redact(
                    raw[:512].decode("utf-8", errors="replace"),
                    (self.credential,),
                ),
            ) from exc

    def request_sse(
        self,
        resource: str,
        payload: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        total = 0
        with self._open(
            "POST",
            resource,
            payload,
            accept="text/event-stream",
        ) as response:
            content_type = (response.headers.get("Content-Type") or "").casefold()
            if "text/event-stream" not in content_type:
                raise SmokeError(
                    "unexpected_content_type",
                    f"expected text/event-stream, received {content_type or 'missing Content-Type'}",
                    request_id=_request_id(response.headers),
                )
            while True:
                line = response.readline(MAX_RESPONSE_BYTES + 1)
                if not line:
                    break
                total += len(line)
                if total > MAX_RESPONSE_BYTES:
                    raise SmokeError(
                        "response_too_large",
                        f"stream exceeded {MAX_RESPONSE_BYTES} bytes",
                    )
                stripped = line.decode("utf-8", errors="strict").strip()
                if not stripped.startswith("data:"):
                    continue
                data = stripped[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    event = json.loads(data)
                except json.JSONDecodeError as exc:
                    raise SmokeError(
                        "malformed_sse",
                        f"stream event was not valid JSON: {exc}",
                        response_preview=_redact(data[:512], (self.credential,)),
                    ) from exc
                if not isinstance(event, dict):
                    raise SmokeError("malformed_sse", "stream event must be a JSON object")
                events.append(event)
        if not events:
            raise SmokeError("empty_stream", "stream ended without any JSON events")
        return events


def _models(payload: Any) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise SmokeError("discovery_shape", "model discovery must return an object with data[]")
    entries = payload["data"]
    if len(entries) > MAX_MODELS:
        raise SmokeError(
            "discovery_too_large",
            f"model discovery returned more than {MAX_MODELS} entries",
        )
    models: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise SmokeError("discovery_shape", "every model entry must be an object")
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            raise SmokeError("discovery_shape", "every model entry must have a non-empty id")
        models.append(model_id.strip())
    return models


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)
    return ""


def _plain_payload(protocol: str, model: str, *, stream: bool = False) -> dict[str, Any]:
    if protocol == "openai-chat":
        return {
            "model": model,
            "messages": [{"role": "user", "content": "Reply with pong."}],
            "max_tokens": 16,
            "temperature": 0,
            "stream": stream,
        }
    if protocol == "openai-responses":
        return {
            "model": model,
            "input": "Reply with pong.",
            "max_output_tokens": 16,
            "stream": stream,
        }
    return {
        "model": model,
        "max_tokens": 16,
        "temperature": 0,
        "messages": [{"role": "user", "content": "Reply with pong."}],
        "stream": stream,
    }


def _generation_resource(protocol: str) -> str:
    return {
        "openai-chat": "chat/completions",
        "openai-responses": "responses",
        "anthropic-messages": "messages",
    }[protocol]


def _parse_text(protocol: str, payload: Any) -> str:
    if not isinstance(payload, dict):
        raise SmokeError("response_shape", "generation response must be a JSON object")
    if protocol == "openai-chat":
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise SmokeError("response_shape", "chat response must contain choices[0]")
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise SmokeError("response_shape", "chat response must contain choices[0].message")
        text = _text_from_content(message.get("content"))
    elif protocol == "openai-responses":
        text = payload.get("output_text") if isinstance(payload.get("output_text"), str) else ""
        if not text:
            parts: list[str] = []
            for item in payload.get("output") or []:
                if not isinstance(item, dict):
                    continue
                parts.append(_text_from_content(item.get("content")))
            text = "".join(parts)
    else:
        text = _text_from_content(payload.get("content"))
    if not text.strip():
        raise SmokeError("empty_text", "generation response contained no user-visible text")
    return text


def _tool_payload(protocol: str, model: str) -> dict[str, Any]:
    if protocol == "openai-chat":
        payload = _plain_payload(protocol, model)
        payload.update(
            {
                "messages": [
                    {"role": "user", "content": "Call endpoint_smoke with query health."}
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": _SMOKE_TOOL_NAME,
                            "description": "Offline endpoint compatibility probe.",
                            "parameters": _SMOKE_TOOL_SCHEMA,
                            "strict": True,
                        },
                    }
                ],
                "tool_choice": {
                    "type": "function",
                    "function": {"name": _SMOKE_TOOL_NAME},
                },
            }
        )
        return payload
    if protocol == "openai-responses":
        payload = _plain_payload(protocol, model)
        payload.update(
            {
                "input": "Call endpoint_smoke with query health.",
                "tools": [
                    {
                        "type": "function",
                        "name": _SMOKE_TOOL_NAME,
                        "description": "Offline endpoint compatibility probe.",
                        "parameters": _SMOKE_TOOL_SCHEMA,
                        "strict": True,
                    }
                ],
                "tool_choice": {"type": "function", "name": _SMOKE_TOOL_NAME},
            }
        )
        return payload
    payload = _plain_payload(protocol, model)
    payload.update(
        {
            "messages": [
                {"role": "user", "content": "Call endpoint_smoke with query health."}
            ],
            "tools": [
                {
                    "name": _SMOKE_TOOL_NAME,
                    "description": "Offline endpoint compatibility probe.",
                    "input_schema": _SMOKE_TOOL_SCHEMA,
                }
            ],
            "tool_choice": {"type": "tool", "name": _SMOKE_TOOL_NAME},
        }
    )
    return payload


def _parse_tool_call(protocol: str, payload: Any) -> tuple[str, Any]:
    if not isinstance(payload, dict):
        raise SmokeError("tool_call_shape", "tool response must be a JSON object")
    if protocol == "openai-chat":
        try:
            calls = payload["choices"][0]["message"]["tool_calls"]
            call = calls[0]
            name = call["function"]["name"]
            arguments = call["function"]["arguments"]
        except (KeyError, IndexError, TypeError) as exc:
            raise SmokeError("tool_call_shape", "chat response has no valid tool call") from exc
    elif protocol == "openai-responses":
        calls = [
            item
            for item in payload.get("output") or []
            if isinstance(item, dict) and item.get("type") == "function_call"
        ]
        if not calls:
            raise SmokeError("tool_call_shape", "responses payload has no function_call output")
        name = calls[0].get("name")
        arguments = calls[0].get("arguments")
    else:
        calls = [
            item
            for item in payload.get("content") or []
            if isinstance(item, dict) and item.get("type") == "tool_use"
        ]
        if not calls:
            raise SmokeError("tool_call_shape", "messages payload has no tool_use block")
        name = calls[0].get("name")
        arguments = calls[0].get("input")
    return str(name or ""), arguments


def _validate_tool_call(name: str, arguments: Any) -> None:
    if name != _SMOKE_TOOL_NAME:
        raise SmokeError(
            "tool_name_mismatch",
            f"endpoint returned unregistered tool name {name!r}",
        )
    if isinstance(arguments, str):
        if len(arguments.encode("utf-8")) > MAX_TOOL_ARGUMENT_BYTES:
            raise SmokeError("tool_arguments_too_large", "tool arguments exceed the smoke limit")
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError as exc:
            raise SmokeError("tool_arguments_json", "tool arguments are not valid JSON") from exc
    if not isinstance(arguments, dict):
        raise SmokeError("tool_schema_mismatch", "tool arguments must decode to an object")
    if set(arguments) != {"query"} or arguments.get("query") != "health":
        raise SmokeError(
            "tool_schema_mismatch",
            "tool arguments do not satisfy the registered endpoint_smoke schema",
        )


def _response_format_payload(protocol: str, model: str) -> dict[str, Any]:
    if protocol == "anthropic-messages":
        raise SmokeSkip("Anthropic Messages has no Sophia-baseline response_format field")
    payload = _plain_payload(protocol, model)
    if protocol == "openai-chat":
        payload["messages"] = [
            {"role": "user", "content": 'Return exactly {"status":"ok"}.'}
        ]
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "endpoint_smoke_response",
                "strict": True,
                "schema": _SMOKE_RESPONSE_SCHEMA,
            },
        }
    else:
        payload["input"] = 'Return exactly {"status":"ok"}.'
        payload["text"] = {
            "format": {
                "type": "json_schema",
                "name": "endpoint_smoke_response",
                "strict": True,
                "schema": _SMOKE_RESPONSE_SCHEMA,
            }
        }
    return payload


def _validate_response_format(protocol: str, payload: Any) -> None:
    text = _parse_text(protocol, payload)
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SmokeError(
            "response_format_invalid",
            "endpoint ignored or violated the requested JSON response format",
        ) from exc
    if decoded != {"status": "ok"}:
        raise SmokeError(
            "response_format_schema_mismatch",
            "structured response does not satisfy the registered smoke schema",
        )


def _parse_stream_text(protocol: str, events: Sequence[Mapping[str, Any]]) -> str:
    parts: list[str] = []
    for event in events:
        if protocol == "openai-chat":
            for choice in event.get("choices") or []:
                if isinstance(choice, dict):
                    delta = choice.get("delta")
                    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                        parts.append(delta["content"])
        elif protocol == "openai-responses":
            if event.get("type") == "response.output_text.delta" and isinstance(
                event.get("delta"), str
            ):
                parts.append(event["delta"])
        else:
            if event.get("type") == "content_block_delta":
                delta = event.get("delta")
                if isinstance(delta, dict) and isinstance(delta.get("text"), str):
                    parts.append(delta["text"])
    text = "".join(parts)
    if not text.strip():
        raise SmokeError("empty_stream", "stream contained no user-visible text delta")
    return text


def _run_check(name: str, operation: Callable[[], Any], *, secrets: Sequence[str]) -> CheckResult:
    started = time.monotonic()
    try:
        operation()
    except SmokeSkip as exc:
        return CheckResult(
            name=name,
            status="skip",
            latency_ms=round((time.monotonic() - started) * 1000),
            diagnostic_code="not_applicable",
            message=_redact(str(exc), secrets),
        )
    except SmokeError as exc:
        return CheckResult(
            name=name,
            status="fail",
            latency_ms=round((time.monotonic() - started) * 1000),
            diagnostic_code=exc.code,
            message=_redact(str(exc), secrets),
            http_status=exc.status,
            request_id=exc.request_id,
            response_preview=_redact(exc.response_preview or "", secrets) or None,
        )
    except Exception as exc:  # noqa: BLE001 - CLI diagnostics must not traceback or leak
        return CheckResult(
            name=name,
            status="fail",
            latency_ms=round((time.monotonic() - started) * 1000),
            diagnostic_code="unexpected_error",
            message=_redact(f"{type(exc).__name__}: {exc}", secrets),
        )
    return CheckResult(
        name=name,
        status="pass",
        latency_ms=round((time.monotonic() - started) * 1000),
    )


def run_smoke(
    *,
    base_url: str,
    protocol: str,
    model: str,
    credential_env: str | None = None,
    probes: Sequence[str] = DEFAULT_PROBES,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    confirm_public_remote: bool = False,
    confirm_private_network: bool = False,
    resolver: Callable[..., Sequence[tuple[Any, ...]]] = socket.getaddrinfo,
    ssl_context: ssl.SSLContext | None = None,
    use_environment_proxy: bool = False,
) -> dict[str, Any]:
    """Run selected protocol probes and return a stable JSON-compatible report."""
    if protocol not in PROTOCOLS:
        raise ValueError(f"protocol must be one of {', '.join(PROTOCOLS)}")
    if not model.strip() or len(model) > 512 or _CONTROL_RE.search(model):
        raise ValueError("model must be a non-empty identifier of at most 512 characters")
    if not 0.1 <= timeout_sec <= 30:
        raise ValueError("timeout_sec must be between 0.1 and 30 seconds")
    unknown = set(probes) - set(DEFAULT_PROBES)
    if unknown:
        raise ValueError(f"unknown probes: {sorted(unknown)}")
    credential = ""
    if credential_env:
        if not _ENV_NAME_RE.fullmatch(credential_env):
            raise ValueError("credential_env must be an uppercase environment-variable name")
        credential = os.environ.get(credential_env, "")

    target = validate_base_url(
        base_url,
        confirm_public_remote=confirm_public_remote,
        confirm_private_network=confirm_private_network,
        resolver=resolver,
    )
    client = EndpointHttpClient(
        target,
        protocol=protocol,
        credential=credential,
        timeout_sec=timeout_sec,
        ssl_context=ssl_context,
        use_environment_proxy=use_environment_proxy,
    )
    results: list[CheckResult] = []
    secrets = (credential,)

    if "discovery" in probes:
        def discovery() -> None:
            try:
                found = _models(client.request_json("GET", "models"))
            except SmokeError as exc:
                if protocol == "anthropic-messages" and exc.status in {404, 405, 501}:
                    raise SmokeSkip(
                        "model discovery is optional for Anthropic-compatible endpoints"
                    ) from exc
                raise
            if model not in found:
                raise SmokeError(
                    "model_not_discovered",
                    f"selected model {model!r} was not returned by bounded discovery",
                )

        results.append(_run_check("discovery", discovery, secrets=secrets))

    if "text" in probes:
        results.append(
            _run_check(
                "text",
                lambda: _parse_text(
                    protocol,
                    client.request_json(
                        "POST",
                        _generation_resource(protocol),
                        _plain_payload(protocol, model),
                    ),
                ),
                secrets=secrets,
            )
        )

    if "tools" in probes:
        def tools() -> None:
            name, arguments = _parse_tool_call(
                protocol,
                client.request_json(
                    "POST",
                    _generation_resource(protocol),
                    _tool_payload(protocol, model),
                ),
            )
            _validate_tool_call(name, arguments)

        results.append(_run_check("tools", tools, secrets=secrets))

    if "response_format" in probes:
        def response_format() -> None:
            payload = _response_format_payload(protocol, model)
            response = client.request_json(
                "POST",
                _generation_resource(protocol),
                payload,
            )
            _validate_response_format(protocol, response)

        results.append(
            _run_check("response_format", response_format, secrets=secrets)
        )

    if "stream" in probes:
        def stream() -> None:
            payload = _plain_payload(protocol, model, stream=True)
            events = client.request_sse(_generation_resource(protocol), payload)
            _parse_stream_text(protocol, events)

        results.append(_run_check("stream", stream, secrets=secrets))

    report = {
        "schema": SCHEMA,
        "protocol": protocol,
        "model": model,
        "target": target.public_dict(),
        "credentialSource": (
            {"type": "environment", "name": credential_env, "present": bool(credential)}
            if credential_env
            else {"type": "none", "present": False}
        ),
        "checks": [result.to_dict() for result in results],
        "ok": all(result.status != "fail" for result in results),
        "candidateOnly": True,
        "canClaimAGI": False,
        "scope": "transport compatibility only; not a security or capability certification",
    }
    serialized = json.dumps(report, sort_keys=True)
    if credential and credential in serialized:
        raise RuntimeError("credential redaction invariant violated")
    return report


def _ssl_context(args: argparse.Namespace) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=args.ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    if args.client_key and not args.client_cert:
        raise ValueError("--client-key requires --client-cert")
    if args.client_cert:
        context.load_cert_chain(args.client_cert, keyfile=args.client_key)
    return context


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a bounded custom-model endpoint compatibility smoke."
    )
    parser.add_argument("--base-url", required=True, help="Exact API prefix, usually ending in /v1")
    parser.add_argument("--protocol", choices=PROTOCOLS, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--credential-env",
        help="Read an optional API key from this environment variable; never pass a key inline",
    )
    parser.add_argument(
        "--probes",
        default=",".join(DEFAULT_PROBES),
        help=f"Comma-separated subset of: {', '.join(DEFAULT_PROBES)}",
    )
    parser.add_argument("--timeout-sec", type=float, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument(
        "--confirm-public-remote",
        action="store_true",
        help="Explicitly authorize a public remote endpoint; HTTPS remains mandatory",
    )
    parser.add_argument(
        "--confirm-private-network",
        action="store_true",
        help="Explicitly authorize a private/LAN endpoint; HTTPS remains mandatory off loopback",
    )
    parser.add_argument("--ca-file", help="Optional operator-approved CA bundle")
    parser.add_argument("--client-cert", help="Optional mTLS client certificate")
    parser.add_argument("--client-key", help="Optional mTLS private-key path")
    parser.add_argument(
        "--use-environment-proxy",
        action="store_true",
        help="Opt into HTTP(S)_PROXY from the environment",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    probes = tuple(item.strip() for item in args.probes.split(",") if item.strip())
    try:
        report = run_smoke(
            base_url=args.base_url,
            protocol=args.protocol,
            model=args.model,
            credential_env=args.credential_env,
            probes=probes,
            timeout_sec=args.timeout_sec,
            confirm_public_remote=args.confirm_public_remote,
            confirm_private_network=args.confirm_private_network,
            ssl_context=_ssl_context(args),
            use_environment_proxy=args.use_environment_proxy,
        )
    except (EndpointSafetyError, SmokeError, ValueError) as exc:
        report = {
            "schema": SCHEMA,
            "ok": False,
            "diagnosticCode": "configuration_error",
            "message": str(exc),
            "candidateOnly": True,
            "canClaimAGI": False,
        }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
