# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Canonical secret / PII / internal-identifier patterns, shared by the prompt
hygiene linter (``tools/check_prompt_hygiene.py``), the corpus scrubber
(``agent/corpus_scrub.py``), and the output-leakage filter.

Deterministic and dependency-free. The gateway keeps its OWN copy (see
``gateway/output_guard.py``) so it stays standalone; this module is the source of
truth for the offline tools and is the place to extend a pattern once.
"""

from __future__ import annotations

import re

# Provider / cloud credential shapes. Conservative — aimed at high precision so
# the CI gate does not cry wolf on ordinary prose.
SECRET_PATTERNS: dict[str, str] = {
    # OpenAI issues PROJECT keys as "sk-proj-<...>" (and has used other
    # "sk-<label>-" prefixes). The old class stopped at the first hyphen, so
    # "sk-" + "proj" was only 4 alphanumerics and never reached the 20-char
    # floor — every current-format key passed through unredacted. Allow the
    # separators inside the body; the 20-char floor still keeps prose safe.
    # ...and anchored: without the lookbehind, "sk-" matches INSIDE ordinary
    # words (a-sk-, ta-sk-, di-sk-) and the hygiene gate cries wolf on prose,
    # which is exactly what this table is tuned to avoid.
    "openai_key": r"(?<![A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_\-]{19,}",
    "anthropic_key": r"sk-ant-[A-Za-z0-9_\-]{20,}",
    "hf_token": r"hf_[A-Za-z0-9]{20,}",
    "xai_key": r"xai-[A-Za-z0-9]{20,}",
    "google_key": r"AIza[0-9A-Za-z_\-]{30,}",
    "aws_access_key": r"AKIA[0-9A-Z]{16}",
    "github_pat": r"gh[pousr]_[A-Za-z0-9]{30,}",
    "slack_token": r"xox[baprs]-[A-Za-z0-9-]{10,}",
    "private_key_block": r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "generic_bearer": r"(?i)bearer\s+[A-Za-z0-9._\-]{20,}",
    "aws_secret_assignment": r"(?i)aws_secret_access_key\s*[=:]\s*['\"]?[A-Za-z0-9/+]{30,}",
}

# Internal identifiers that should never appear in a public prompt or corpus.
INTERNAL_PATTERNS: dict[str, str] = {
    "private_ip": r"\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b",
    "localhost_url_with_cred": r"https?://[^\s/@]+:[^\s/@]+@",
    "home_path": r"/(?:home|Users)/[A-Za-z0-9._-]+/",
    "internal_tld": r"\b[a-z0-9.-]+\.(?:internal|local|corp|intranet)\b",
}

# PII shapes for the corpus scrubber. Email is intentionally broad; the others are
# precise. We do NOT try to catch names — that needs NER and is out of scope here.
PII_PATTERNS: dict[str, str] = {
    # ReDoS-safe email: domain is non-overlapping labels separated by literal
    # dots (the label class excludes '.'), so there is no ambiguous '+' vs '\.'.
    "email": r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+",
    "us_ssn": r"\b\d{3}-\d{2}-\d{4}\b",
    # Linear form: one leading digit then 12–15 (sep? + digit) groups; each step
    # consumes a digit, so no catastrophic backtracking.
    "credit_card": r"\b\d(?:[ -]?\d){12,15}\b",
    "us_phone": r"\b(?:\+?1[ \-.]?)?\(?\d{3}\)?[ \-.]\d{3}[ \-.]\d{4}\b",
}

_SECRET_RX = {k: re.compile(v) for k, v in SECRET_PATTERNS.items()}
_INTERNAL_RX = {k: re.compile(v) for k, v in INTERNAL_PATTERNS.items()}
_PII_RX = {k: re.compile(v) for k, v in PII_PATTERNS.items()}

# Diagnostics are a more hostile boundary than public prose: provider errors
# and subprocess exceptions routinely echo operator-supplied environment
# values, command lines, or authentication output even when the credential
# does not match a known provider key shape. Keep these patterns separate from
# ``SECRET_PATTERNS`` so the corpus/prompt scanner remains high precision.
_DIAGNOSTIC_SENSITIVE_ASSIGNMENT_RX = re.compile(
    r"""(?ix)
    (
        \b
        (?:[A-Z][A-Z0-9_]*_)?
        (?:
            API[_-]?KEY
            | TOKEN
            | SECRET
            | PASSWORD
            | PASSWD
            | CREDENTIALS?
            | AUTHORIZATION
            | PRIVATE[_-]?KEY
            | ACCESS[_-]?KEY
        )
        \s*[:=]\s*
    )
    (["']?)
    ([^\s,;"']+)
    \2
    """,
)
_DIAGNOSTIC_SECRET_FLAG_RX = re.compile(
    r"""(?ix)
    (
        --(?:
            api[-_]?key
            | token
            | secret
            | password
            | passwd
            | credential
            | authorization
            | private[-_]?key
            | access[-_]?key
        )
        (?:\s+|=)
    )
    (["']?)
    ([^\s,;"']+)
    \2
    """,
)
_DIAGNOSTIC_AUTH_HEADER_RX = re.compile(
    r"(?i)((?:authorization\s*:\s*(?:bearer\s+)?|x-api-key\s*[:=]\s*))[^\s,;]+",
)
_DIAGNOSTIC_RAW_FIELD_RX = re.compile(
    r"""(?imx)
    (^|[\s,{;])
    (
        (?:
            (?:raw[_ -]?)?
            (?:subprocess[_ -]?)?
            (?:command(?:[_ -]?line)?|cmd|argv)
            | auth(?:entication)?[_ -]?output
            | login[_ -]?output
        )
        \s*[:=]\s*
    )
    [^\r\n]*?
    (?=
        \s+
        (?:
            (?:[A-Z][A-Z0-9_]*_)?
            (?:
                API[_-]?KEY
                | TOKEN
                | SECRET
                | PASSWORD
                | PASSWD
                | CREDENTIALS?
                | AUTHORIZATION
                | PRIVATE[_-]?KEY
                | ACCESS[_-]?KEY
            )
            | auth(?:entication)?[_ -]?output
            | login[_ -]?output
        )
        \s*[:=]
        | \s+(?:timed\s+out|returned|failed)\b
        | $
    )
    """,
)
_DIAGNOSTIC_SUBPROCESS_EXCEPTION_RX = re.compile(
    r"(?is)\bcommand\s+.+?(?=\s+(?:timed out|returned|failed)(?:\s|$))",
)


def _matches(text: str, table: "dict[str, re.Pattern[str]]") -> "list[dict]":
    out: list[dict] = []
    for name, rx in table.items():
        for m in rx.finditer(text or ""):
            out.append({"kind": name, "match": m.group(0), "start": m.start(), "end": m.end()})
    return out


def find_secrets(text: str) -> "list[dict]":
    """Credential-shaped substrings (the highest-severity finding)."""
    return _matches(text, _SECRET_RX)


def find_internal(text: str) -> "list[dict]":
    """Internal hostnames / IPs / home paths that leak deployment detail."""
    return _matches(text, _INTERNAL_RX)


def find_pii(text: str) -> "list[dict]":
    """Email / SSN / card / phone shapes for corpus scrubbing."""
    return _matches(text, _PII_RX)


def find_all(text: str) -> "list[dict]":
    return find_secrets(text) + find_internal(text) + find_pii(text)


def redact(text: str, *, secrets: bool = True, internal: bool = True, pii: bool = True) -> str:
    """Replace every matched span with a typed ``[REDACTED:<kind>]`` token.

    Applied longest-first per pass so overlapping matches don't corrupt offsets.
    """
    tables: list[dict] = []
    if secrets:
        tables.append(_SECRET_RX)
    if internal:
        tables.append(_INTERNAL_RX)
    if pii:
        tables.append(_PII_RX)
    out = text or ""
    for table in tables:
        for name, rx in table.items():
            out = rx.sub(f"[REDACTED:{name}]", out)
    return out


def redact_diagnostic(text: str, *, secrets: "Iterable[str]" = ()) -> str:
    """Redact untrusted provider/subprocess diagnostics before persistence.

    In addition to known credential shapes, diagnostics must not expose exact
    configured secrets, generic credential assignments, secret-bearing CLI
    flags, raw command lines, authentication output, home paths, or PII.
    """
    out = text or ""
    for secret in secrets:
        if secret:
            out = out.replace(str(secret), "[REDACTED]")
    out = redact(out, secrets=True, internal=True, pii=True)
    out = _DIAGNOSTIC_AUTH_HEADER_RX.sub(r"\1[REDACTED]", out)
    out = _DIAGNOSTIC_SENSITIVE_ASSIGNMENT_RX.sub(r"\1[REDACTED]", out)
    out = _DIAGNOSTIC_SECRET_FLAG_RX.sub(r"\1[REDACTED]", out)
    out = _DIAGNOSTIC_RAW_FIELD_RX.sub(r"\1\2[REDACTED]", out)
    out = _DIAGNOSTIC_SUBPROCESS_EXCEPTION_RX.sub("Command [REDACTED]", out)
    return out


__all__ = [
    "SECRET_PATTERNS", "INTERNAL_PATTERNS", "PII_PATTERNS",
    "find_secrets", "find_internal", "find_pii", "find_all", "redact",
    "redact_diagnostic",
]
