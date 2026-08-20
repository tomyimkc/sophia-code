# PLANNING/SUBSTRATE ONLY - no capability claim; canClaimAGI stays false.
"""OKF (Open Knowledge Format) schema: traceable-memory node + markdown roundtrip.

PURE / OFFLINE / DETERMINISTIC. stdlib only.
Implements the SHARED OKF API CONTRACT exactly:
  OKFNode dataclass, content_id, to_markdown, from_markdown, validate.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

NODE_TYPES = {
    "fact", "step", "skill", "decision",
    # loop-engineering step kinds (observe -> reason -> act -> verify -> resolve);
    # 'decision' doubles as the "decide" step. See agent/okf_loop.py.
    "event", "observe", "reason", "act", "verify", "resolve",
}
VERDICTS = {"pass", "fail", "none"}  # None also allowed


@dataclass
class OKFNode:
    id: str
    node_type: str  # one of: fact|step|skill|decision
    title: str
    body: str
    sources: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    verifier: str | None = None
    verdict: str | None = None  # pass|fail|none
    moral_standard: str | None = None


def content_id(node_type: str, title: str, body: str) -> str:
    """Deterministic content id. Form: '<node_type>:<hex12>' using sha256 only."""
    h = hashlib.sha256()
    # length-prefixed fields to avoid ambiguity/collision between boundaries
    for part in (node_type, title, body):
        b = part.encode("utf-8")
        h.update(str(len(b)).encode("ascii"))
        h.update(b":")
        h.update(b)
    hex12 = h.hexdigest()[:12]
    return f"{node_type}:{hex12}"


# ---------------------------------------------------------------------------
# Minimal frontmatter (YAML-ish) serialization -- no PyYAML dependency.
# Supports scalar `key: value` and list `key: ["a","b"]` forms.
# ---------------------------------------------------------------------------

_NONE_SENTINEL = "null"


def _dump_scalar(value: str | None) -> str:
    if value is None:
        return _NONE_SENTINEL
    return value


def _dump_list(values: list[str]) -> str:
    inner = ", ".join('"' + _escape(v) + '"' for v in values)
    return "[" + inner + "]"


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _unescape(s: str) -> str:
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append(s[i + 1])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _parse_list(raw: str) -> list[str]:
    raw = raw.strip()
    assert raw.startswith("[") and raw.endswith("]"), f"bad list: {raw!r}"
    inner = raw[1:-1].strip()
    if not inner:
        return []
    items: list[str] = []
    i = 0
    n = len(inner)
    while i < n:
        # skip whitespace and commas
        while i < n and inner[i] in ", \t":
            i += 1
        if i >= n:
            break
        assert inner[i] == '"', f"list items must be quoted: {raw!r}"
        i += 1
        buf = []
        while i < n:
            c = inner[i]
            if c == "\\" and i + 1 < n:
                buf.append(inner[i + 1])
                i += 2
                continue
            if c == '"':
                i += 1
                break
            buf.append(c)
            i += 1
        items.append("".join(buf))
    return items


def to_markdown(node: OKFNode) -> str:
    """Serialize OKFNode to frontmatter + body, mirroring the wiki format."""
    lines = ["---"]
    lines.append(f"id: {node.id}")
    lines.append(f"node_type: {node.node_type}")
    lines.append(f"sources: {_dump_list(node.sources)}")
    lines.append(f"links: {_dump_list(node.links)}")
    lines.append(f"verifier: {_dump_scalar(node.verifier)}")
    lines.append(f"verdict: {_dump_scalar(node.verdict)}")
    lines.append(f"moral_standard: {_dump_scalar(node.moral_standard)}")
    lines.append(f"title: {node.title}")
    lines.append("---")
    lines.append("")
    lines.append(node.body)
    return "\n".join(lines)


def from_markdown(text: str) -> OKFNode:
    """Parse frontmatter + body back into an OKFNode (exact roundtrip)."""
    lines = text.split("\n")
    assert lines and lines[0] == "---", "missing opening frontmatter delimiter"
    i = 1
    fm: dict[str, str] = {}
    while i < len(lines):
        line = lines[i]
        if line == "---":
            i += 1
            break
        # split on first ': '
        key, _, raw = line.partition(": ")
        if not _:
            # tolerate 'key:' with empty value
            key, _, raw = line.partition(":")
        fm[key.strip()] = raw
        i += 1
    # body is everything after the closing '---' and one blank separator line
    body_lines = lines[i:]
    if body_lines and body_lines[0] == "":
        body_lines = body_lines[1:]
    body = "\n".join(body_lines)

    def scalar(key: str) -> str | None:
        v = fm.get(key, _NONE_SENTINEL)
        if v == _NONE_SENTINEL:
            return None
        return v

    return OKFNode(
        id=fm.get("id", ""),
        node_type=fm.get("node_type", ""),
        title=fm.get("title", ""),
        body=body,
        sources=_parse_list(fm.get("sources", "[]")),
        links=_parse_list(fm.get("links", "[]")),
        verifier=scalar("verifier"),
        verdict=scalar("verdict"),
        moral_standard=scalar("moral_standard"),
    )


def validate(node: OKFNode) -> list[str]:
    """Return list of problems; [] means valid."""
    errs: list[str] = []
    if node.node_type not in NODE_TYPES:
        errs.append(f"node_type {node.node_type!r} not in {sorted(NODE_TYPES)}")
    expected = content_id(node.node_type, node.title, node.body)
    if node.id != expected:
        errs.append(f"id {node.id!r} != content_id {expected!r}")
    if node.verdict is not None and node.verdict not in VERDICTS:
        errs.append(f"verdict {node.verdict!r} not in {sorted(VERDICTS)} or None")
    return errs
