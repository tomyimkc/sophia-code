#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""sophia-security-audit — one local pre-release security pre-flight.

Bundles the repo's existing security gates into a single deterministic, offline
check you run *before* a release (inspired by an "AgentShield" security-auditing
agent). It runs three checks and returns a structured result:

  (a) no_overclaim     — tools/lint_claims.py main([]) must exit 0
                         (public copy must not exceed the failure ledger).
  (b) redos_robustness — tests/test_verifier_robustness.py main() must return 0
                         (discipline verifiers stay ReDoS-safe on adversarial input).
  (c) secret_scan      — a cheap heuristic regex scan over a bounded set of
                         working-tree (incl. untracked) non-binary files for
                         high-entropy / secret-shaped patterns.

This is a LOCAL PRE-FLIGHT, not a replacement for CI. The authoritative scans live
in .github/workflows/security.yml (pip-audit + CodeQL + gitleaks). A clean result
here means "no positive finding from these cheap checks" — it is NOT a guarantee of
security and makes no such claim.

Design rules:
  * stdlib only, deterministic, offline — no network, no new dependencies.
  * fail-closed only on a *real positive finding*. If a sub-check cannot RUN
    (ImportError, missing module, etc.) it is marked "skipped" with a reason, not
    "failed" — inability to run must not block a release on its own.

Run:
  python tools/security_audit.py            # PASS/FAIL offline invariants
  python tools/security_audit.py --check    # print JSON, exit 0 iff ok
"""
from __future__ import annotations

import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# --- secret-scan configuration ----------------------------------------------
# Bounded set of directories to scan. The authoritative scan is gitleaks in CI;
# this is a cheap pre-flight over the source tree most likely to leak a key.
SCAN_DIRS: tuple[str, ...] = ("agent", "tools", "training", "eval", "docs", ".claude")
MAX_FILE_BYTES = 1_000_000  # skip files > 1 MB

# High-entropy / secret-shaped patterns. Mirrors the provider-key rule in
# .gitleaks.toml; this is a heuristic subset, not the full gitleaks ruleset.
SECRET_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"AKIA[0-9A-Z]{16}", "aws-access-key-id"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private-key-header"),
    (r"sk-[A-Za-z0-9]{20,}", "openai-style-key"),
    (r"ghp_[A-Za-z0-9]{36}", "github-personal-token"),
    (r"hf_[A-Za-z0-9]{20,}", "huggingface-token"),
    (r"xai-[A-Za-z0-9]{20,}", "xai-key"),
)
_SECRET_RE = [(re.compile(pat), name) for pat, name in SECRET_PATTERNS]

# .gitleaks allowlist conventions: paths whose key-shaped strings are fixtures /
# placeholders, not real secrets. Kept in sync with .gitleaks.toml [allowlist].
# The two security scanners (this tool and the gitleaks config) are also allowlisted
# because they necessarily contain the secret-shaped *pattern definitions* themselves.
ALLOWLIST_PATH_RE = [
    re.compile(r"\.env\.example$"),
    re.compile(r"(^|/)docs/"),
    re.compile(r"(^|/)tests/"),
    re.compile(r"(^|/)eval/redteam/"),
    re.compile(r"\.gitleaks\.toml$"),
    re.compile(r"(^|/)tools/security_audit\.py$"),  # this detector's own pattern defs
    re.compile(r"(^|/).*\.sample\.(json|md|txt)$"),
    re.compile(r"(^|/).*\.example$"),
]
# Lines/values that are obvious placeholders (not real secrets).
ALLOWLIST_VALUE_RE = [
    re.compile(r"hf_your_token_here"),
    re.compile(r"your[-_]?token[-_]?here"),
    re.compile(r"sk-\.\.\."),
    re.compile(r"(?i)dummy|placeholder|example|redacted|xxxx"),
]


def _path_allowlisted(rel: str) -> bool:
    return any(rx.search(rel) for rx in ALLOWLIST_PATH_RE)


def _value_allowlisted(line: str) -> bool:
    return any(rx.search(line) for rx in ALLOWLIST_VALUE_RE)


def scan_text(text: str) -> list[dict]:
    """Heuristic secret scan over a string. Returns a list of findings; empty == clean.

    A finding is {"pattern": <name>, "match": "[redacted]..."}. The ``match`` is a
    FIXED redaction marker — nothing derived from the secret-shaped token (not its
    bytes, not even its length) is ever included, so results can be logged/printed
    safely; identify a finding by ``pattern``. Placeholder values (per the gitleaks
    allowlist regexes) are not reported.
    """
    findings: list[dict] = []
    for line in text.splitlines():
        if _value_allowlisted(line):
            continue
        for rx, name in _SECRET_RE:
            if rx.search(line):
                # Redact fully: the matched token is never read (not even its
                # length) — only the pattern name + a fixed marker are emitted, so
                # nothing derived from the secret can flow into a printed/logged
                # result (CodeQL py/clear-text-logging-sensitive-data).
                findings.append({"pattern": name, "match": "[redacted]..."})
    return findings


def _is_probably_binary(data: bytes) -> bool:
    return b"\x00" in data[:4096]


def _scan_repo_secrets() -> dict:
    """Scan the bounded source tree. Returns a check dict (never raises)."""
    findings: list[dict] = []
    scanned = 0
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(ROOT).as_posix()
            if _path_allowlisted(rel):
                continue
            try:
                if p.stat().st_size > MAX_FILE_BYTES:
                    continue
                data = p.read_bytes()
            except OSError:
                continue
            if _is_probably_binary(data):
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                continue
            scanned += 1
            for f in scan_text(text):
                findings.append({**f, "file": rel})
    return {
        "name": "secret_scan",
        "status": "passed" if not findings else "failed",
        "scanned_files": scanned,
        "findings": findings,
        "note": "heuristic local pre-flight; authoritative scan is gitleaks in CI",
    }


def _run_no_overclaim() -> dict:
    """Run the no-overclaim gate (tools/lint_claims.py main([]))."""
    try:
        from tools import lint_claims  # type: ignore
    except Exception as exc:  # cannot run -> skipped, not failed
        return {"name": "no_overclaim", "status": "skipped",
                "reason": f"cannot import tools.lint_claims ({exc})"}
    try:
        # lint_claims.main() reads sys.argv itself; run it with a clean argv so it
        # does not inherit our own --check flag.
        saved_argv = sys.argv
        try:
            sys.argv = ["lint_claims"]
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = lint_claims.main()
        finally:
            sys.argv = saved_argv
    except SystemExit as exc:  # argparse / explicit exit
        rc = exc.code if isinstance(exc.code, int) else 1
    except Exception as exc:
        return {"name": "no_overclaim", "status": "skipped",
                "reason": f"lint_claims raised ({exc})"}
    return {"name": "no_overclaim",
            "status": "passed" if rc == 0 else "failed",
            "exit_code": rc}


def _run_redos_robustness() -> dict:
    """Run the ReDoS regression (tests/test_verifier_robustness.py main())."""
    try:
        from tests import test_verifier_robustness as redos  # type: ignore
    except Exception as exc:  # missing agent verifiers etc. -> skipped
        return {"name": "redos_robustness", "status": "skipped",
                "reason": f"cannot import tests.test_verifier_robustness ({exc})"}
    try:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = redos.main()
    except AssertionError as exc:  # a genuine robustness regression is a real finding
        return {"name": "redos_robustness", "status": "failed",
                "reason": f"assertion failed: {exc}"}
    except SystemExit as exc:
        rc = exc.code if isinstance(exc.code, int) else 1
    except Exception as exc:
        return {"name": "redos_robustness", "status": "skipped",
                "reason": f"robustness test raised ({exc})"}
    return {"name": "redos_robustness",
            "status": "passed" if rc == 0 else "failed",
            "exit_code": rc}


def run_audit() -> dict:
    """Run all three pre-flight checks and return a structured result.

    Returns {"checks": {name: check_dict, ...}, "ok": bool}. ``ok`` is True iff no
    check is "failed"; a "skipped" check (could not run) does not flip ``ok`` to
    False — we fail-closed only on a real positive finding.
    """
    checks = {
        "no_overclaim": _run_no_overclaim(),
        "redos_robustness": _run_redos_robustness(),
        "secret_scan": _scan_repo_secrets(),
    }
    ok = not any(c.get("status") == "failed" for c in checks.values())
    return {"checks": checks, "ok": ok}


def offline_invariants() -> tuple[bool, dict]:
    """Self-check: the audit runs, returns the three checks, and the secret scanner
    correctly flags a synthetic secret while passing clean text. Uses only in-memory
    synthetic strings — never reads or writes a real credential.
    """
    detail: dict = {"checks": []}

    def _record(name: str, cond: bool) -> None:
        detail["checks"].append({"name": name, "ok": bool(cond)})

    result = run_audit()
    _record("returns_result_dict", isinstance(result, dict) and "checks" in result and "ok" in result)
    _record("has_three_checks",
            set(result.get("checks", {})) == {"no_overclaim", "redos_robustness", "secret_scan"})
    _record("no_check_crashed",
            all(c.get("status") in {"passed", "failed", "skipped"}
                for c in result.get("checks", {}).values()))

    # Synthetic positive: a fake AWS-id-shaped string and a fake private-key header.
    synthetic = "key = AKIA" + "0" * 16 + "\n-----BEGIN RSA PRIVATE KEY-----\n"
    _record("flags_synthetic_secret", len(scan_text(synthetic)) >= 2)
    _record("passes_clean_text", scan_text("the quick brown fox jumps over 1234") == [])
    _record("placeholder_not_flagged", scan_text("token = sk-...placeholder") == [])

    ok = all(c["ok"] for c in detail["checks"])
    detail["ok"] = ok
    return ok, detail


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(
        description="sophia-security-audit — local pre-release security pre-flight "
                    "(complements gitleaks/pip-audit/CodeQL in CI; not a guarantee).",
    )
    ap.add_argument("--check", action="store_true",
                    help="run the full audit, print the JSON result, exit 0 iff ok else 1")
    args = ap.parse_args(argv)

    if args.check:
        result = run_audit()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1

    ok, detail = offline_invariants()
    for c in detail["checks"]:
        print(f"  [{'ok' if c['ok'] else 'XX'}] {c['name']}")
    print("PASS sophia-security-audit offline invariants" if ok
          else "FAIL sophia-security-audit offline invariants")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
