# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Pluggable verifiers for the agent harness, eval, and RL loops.

A verifier is ``(text, task, step) -> {"passed": bool, "reasons": [...], "detail": {...}}``
matching agent.harness. These turn "looks good" into "verified": exact answers,
regex, keywords, unit tests, rubric scoring, and citation checks — plus
combinators. Quality follows verifiability.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import warnings
from collections import OrderedDict
from glob import glob as _glob
from pathlib import Path
from typing import Any, Callable

from agent.config import DATA_DIR, ROOT

Verifier = Callable[[str, Any, dict], dict]

# Domain files whose records carry doNotAttributeTo lists. The last entry is the
# active-learning sink: records promoted from verified gate misses
# (tools/promote_pending.py) land here, so the live gate fires on them on the next
# run — closing the feedback loop without hand-editing the seed domain files.
_PROVENANCE_FILES = (
    "attributions.json",
    "psychology_concepts.json",
    "religion_concepts.json",
    "history_events.json",
    "science.json",
    "learned_attributions.json",
)


def _ok(detail: dict | None = None) -> dict:
    return {"passed": True, "reasons": [], "detail": detail or {}}


def _fail(reasons: list[str], detail: dict | None = None) -> dict:
    return {"passed": False, "reasons": reasons, "detail": detail or {}}


def exact_match(expected: str, *, normalize: bool = True) -> Verifier:
    """Pass if the answer equals (or, by default, contains) the expected string."""

    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip().lower() if normalize else s

    target = norm(expected)

    def _verify(text: str, task: Any, step: dict) -> dict:
        got = norm(text)
        if target == got or target in got:
            return _ok({"expected": expected})
        return _fail([f"expected '{expected}' not found"], {"expected": expected})

    return _verify


def regex_match(pattern: str, *, flags: int = re.IGNORECASE) -> Verifier:
    compiled = re.compile(pattern, flags)

    def _verify(text: str, task: Any, step: dict) -> dict:
        if compiled.search(text):
            return _ok({"pattern": pattern})
        return _fail([f"pattern /{pattern}/ did not match"], {"pattern": pattern})

    return _verify


def keyword(must_include: list[str] | None = None, must_avoid: list[str] | None = None) -> Verifier:
    must_include = must_include or []
    must_avoid = must_avoid or []

    def _verify(text: str, task: Any, step: dict) -> dict:
        lowered = text.lower()
        missing = [k for k in must_include if k.lower() not in lowered]
        present_forbidden = [k for k in must_avoid if k.lower() in lowered]
        reasons = [f"missing: {k}" for k in missing] + [f"forbidden present: {k}" for k in present_forbidden]
        return _ok() if not reasons else _fail(reasons, {"missing": missing, "forbidden": present_forbidden})

    return _verify


def unit_test(command: list[str], *, cwd: Path = ROOT, timeout_sec: int = 300) -> Verifier:
    """Pass iff a command (pytest/build/lint) exits 0. The answer text is ignored;
    the world state is the verifier (the strongest signal for code tasks)."""

    def _verify(text: str, task: Any, step: dict) -> dict:
        try:
            proc = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout_sec, check=False)
        except subprocess.TimeoutExpired:
            return _fail([f"command timed out: {' '.join(command)}"])
        except FileNotFoundError as exc:
            return _fail([f"command not found: {exc}"])
        if proc.returncode == 0:
            return _ok({"cmd": " ".join(command), "returncode": 0})
        return _fail([f"exit {proc.returncode}: {(proc.stderr or proc.stdout)[-300:]}"], {"returncode": proc.returncode})

    return _verify


def score_pack_case(case: dict, *, threshold: float = 1.0) -> Verifier:
    """Wrap hidden_eval_protocol.score_case as a verifier (rubric/operational)."""
    from tools.hidden_eval_protocol import score_case

    def _verify(text: str, task: Any, step: dict) -> dict:
        result = score_case(case, text)
        ratio = (result["score"] / result["maxPoints"]) if result.get("maxPoints") else 0.0
        passed = ratio >= threshold and result.get("passed", False)
        reasons = [m.get("label", str(m)) for m in result.get("missedRubric", [])]
        return {"passed": passed, "reasons": reasons, "detail": {"score": result["score"], "maxPoints": result["maxPoints"]}}

    return _verify


def citation_present(sources: list[str]) -> Verifier:
    """Pass if the answer cites at least one provided source label/path token."""
    tokens = [s for s in (Path(str(x)).name for x in sources) if s]

    def _verify(text: str, task: Any, step: dict) -> dict:
        lowered = text.lower()
        hit = any(tok.lower() in lowered for tok in tokens) or bool(re.search(r"\[(?:local|web)\s*\d+\]|source", lowered))
        return _ok() if hit else _fail(["no citation to a provided source"], {"sources": tokens})

    return _verify


# --------------------------------------------------------------------------- #
# General machine-checked verifiers — generalize the verifier-gated loop beyond
# provenance: citation faithfulness, executable code, and arithmetic soundness.
# Each is deterministic (no model call) so "verified" means verified.
# --------------------------------------------------------------------------- #

_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "was", "were", "are",
    "be", "by", "for", "with", "that", "this", "it", "as", "at", "from", "his", "her",
    "their", "its", "which", "who", "whom", "they", "he", "she", "but", "not", "no",
}


def _content_words(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 3 and w not in _STOPWORDS}


def citation_faithful(sources: list[str], *, min_overlap: float = 0.35, require_citation: bool = False) -> Verifier:
    """Fail if a cited sentence is NOT supported by its source.

    Sources are 1-indexed for ``[1]`` / ``[local 1]`` / ``[web 1]`` markers. For
    each sentence carrying a citation, the cited source must share at least
    ``min_overlap`` of the sentence's content words (a deterministic support
    check, no model). With ``require_citation`` a declarative factual sentence
    that cites nothing is also flagged. This is RAG citation-faithfulness — the
    gate against "grounded-looking but unsupported" answers.

    Scope (honest): lexical overlap reliably catches fabricated / topically
    mismatched / out-of-range citations. It does NOT catch a subtle wrong
    predicate when the subject still matches the source — that needs a model
    judge (compose with an LLM-judge for that tier).
    """
    src_words = [(_content_words(s), s) for s in sources]

    def _verify(text: str, task: Any, step: dict) -> dict:
        violations: list[str] = []
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
            s = sentence.strip()
            if len(s) < 12:
                continue
            cites = [int(n) for n in re.findall(r"\[(?:local|web|source)?\s*(\d+)\]", s.lower())]
            words = _content_words(s)
            if not words:
                continue
            if cites:
                best = 0.0
                scored = False
                for idx in cites:
                    if 1 <= idx <= len(src_words):
                        sw = src_words[idx - 1][0]
                        if words:
                            best = max(best, len(words & sw) / len(words))
                        scored = True
                    else:
                        violations.append(f"citation [{idx}] out of range")
                if scored and best < min_overlap:
                    violations.append(f"unsupported citation (overlap {best:.0%} < {min_overlap:.0%}): {s[:60]}")
            elif require_citation and re.search(r"\b(?:is|was|were|are|wrote|invented|discovered|founded|caused)\b", s.lower()):
                violations.append(f"uncited claim: {s[:60]}")
        if violations:
            return _fail([f"citation not faithful: {v}" for v in violations], {"violations": violations})
        return _ok({"sourcesChecked": len(sources)})

    return _verify


def _softmax(xs: list) -> list:
    import math

    m = max(xs)
    exps = [math.exp(x - m) for x in xs]
    s = sum(exps) or 1.0
    return [e / s for e in exps]


def _default_nli():
    """A lazy cross-encoder NLI scorer ``(premise, hypothesis) -> entailment prob``.

    Opt-in: needs ``sentence-transformers`` + a model (``$SOPHIA_NLI_MODEL``,
    default ``cross-encoder/nli-deberta-v3-small``). Returns None when unavailable
    so callers FAIL CLOSED rather than silently pass an unchecked claim. Not run in
    CI (no model); the unit tests inject a mock scorer.
    """
    name = os.environ.get("SOPHIA_NLI_MODEL", "cross-encoder/nli-deberta-v3-small")
    try:
        from sentence_transformers import CrossEncoder
    except Exception:
        return None
    try:
        model = CrossEncoder(name)
    except Exception:
        return None

    # Resolve the entailment index from the model's OWN label map — never assume a
    # fixed order (MNLI models use {0:contradiction,1:neutral,2:entailment}, deberta
    # uses {…,1:entailment,…}). If we can't identify it, FAIL CLOSED (return None)
    # rather than silently mis-score in the unsafe direction.
    ent_idx = None
    try:
        id2label = model.config.id2label
        for i, label in id2label.items():
            if str(label).lower().startswith("entail"):
                ent_idx = int(i)
                break
    except Exception:
        ent_idx = None
    if ent_idx is None:
        return None

    def score(premise: str, hypothesis: str) -> float:
        try:
            logits = list(model.predict([(premise, hypothesis)])[0])
        except Exception:
            return 0.0
        probs = _softmax([float(x) for x in logits])
        return float(probs[ent_idx]) if ent_idx < len(probs) else 0.0

    return score


def claim_supported(sources: list[str], *, nli=None, threshold: float = 0.5,
                    require_citation: bool = False) -> Verifier:
    """Fail if a cited sentence is not ENTAILED by its cited source.

    The semantic tier above :func:`citation_faithful`: it catches a *wrong
    predicate even when the subject matches the source* (e.g. "Marie Curie invented
    the telephone [1]" against a source about her radioactivity work) — the lexical
    blind spot the red-team flagged. ``nli(premise, hypothesis) -> float`` in
    ``[0,1]``; defaults to a cross-encoder (opt-in). If no scorer is available the
    verifier FAILS CLOSED (it refuses to vouch) rather than silently passing.

    Scope (honest): entailment detection is only as good as the supplied NLI model
    and ``threshold`` — a weak model or a mis-set threshold can miss a wrong
    predicate or false-positive on a valid claim. Compose it as a tier, not a
    guarantee. The default model is resolved with the correct entailment label;
    a custom ``$SOPHIA_NLI_MODEL`` must expose an "entailment" label or it fails closed.
    """
    scorer = nli or _default_nli()

    def _verify(text: str, task: Any, step: dict) -> dict:
        if scorer is None:
            return _fail(["NLI scorer unavailable — semantic faithfulness not checked"],
                         {"nli": "unavailable"})
        violations: list[str] = []
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
            s = sentence.strip()
            if len(s) < 12:
                continue
            cites = [int(n) for n in re.findall(r"\[(?:local|web|source)?\s*(\d+)\]", s.lower())]
            if cites:
                best = 0.0
                scored = False
                for idx in cites:
                    if 1 <= idx <= len(sources):
                        best = max(best, float(scorer(sources[idx - 1], s)))
                        scored = True
                    else:
                        violations.append(f"citation [{idx}] out of range")
                if scored and best < threshold:
                    violations.append(f"claim not entailed by source (entail {best:.0%} < {threshold:.0%}): {s[:60]}")
            elif require_citation and re.search(r"\b(?:is|was|were|are|wrote|invented|discovered|founded|caused)\b", s.lower()):
                violations.append(f"uncited claim: {s[:60]}")
        if violations:
            return _fail([f"claim unsupported: {v}" for v in violations], {"violations": violations})
        return _ok({"sourcesChecked": len(sources)})

    return _verify


def _extract_code(text: str, language: str = "python") -> str:
    """Concatenate fenced code blocks (``` ```), preferring language-tagged ones."""
    blocks = re.findall(r"```(?:" + re.escape(language) + r"|py)?\s*\n(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if not blocks:
        blocks = re.findall(r"```\s*\n(.*?)```", text, re.DOTALL)
    return "\n\n".join(b.rstrip() for b in blocks)


def code_tests_pass(*, timeout_sec: int = 30, allow_execution: bool = True) -> Verifier:
    """Extract code from the answer and EXECUTE it; pass iff it exits 0.

    The strongest machine check: the produced code (typically asserts / a test
    harness the model wrote) is run in an isolated temp dir. ``allow_execution``
    (or env ``SOPHIA_ALLOW_CODE_EXEC=0``) gates running untrusted code; when off,
    falls back to a safe syntax-only check (``compile``). Times out and never
    touches the repo tree.
    """
    import sys
    import tempfile

    env_off = os.environ.get("SOPHIA_ALLOW_CODE_EXEC", "1").strip() in ("0", "false", "no")

    def _verify(text: str, task: Any, step: dict) -> dict:
        code = _extract_code(text)
        if not code.strip():
            return _fail(["no python code block found"])
        if env_off or not allow_execution:
            try:
                compile(code, "<answer>", "exec")
                return _ok({"mode": "syntax-only", "executed": False})
            except SyntaxError as exc:
                return _fail([f"syntax error: {exc}"], {"executed": False})
        with tempfile.TemporaryDirectory() as tmp:
            sol = Path(tmp) / "solution.py"
            sol.write_text(code, encoding="utf-8")
            try:
                proc = subprocess.run(
                    [sys.executable, str(sol)], cwd=tmp, text=True,
                    capture_output=True, timeout=timeout_sec, check=False,
                )
            except subprocess.TimeoutExpired:
                return _fail([f"code timed out after {timeout_sec}s"], {"executed": True})
        if proc.returncode == 0:
            return _ok({"executed": True, "returncode": 0})
        return _fail([f"code exited {proc.returncode}: {(proc.stderr or proc.stdout)[-300:]}"],
                     {"executed": True, "returncode": proc.returncode})

    return _verify


_ARITH = re.compile(r"(-?\d{1,64}(?:\.\d{1,64})?)\s*([+\-*/×x])\s*(-?\d{1,64}(?:\.\d{1,64})?)\s*=\s*(-?\d{1,64}(?:\.\d{1,64})?)")


def arithmetic_sound(*, tol: float = 1e-6) -> Verifier:
    """Fail if the text states a FALSE arithmetic equality (e.g. '2 + 2 = 5').

    Parses ``a OP b = c`` for + - * / (and × / x), recomputes, and flags any
    mismatch. No model, no eval of arbitrary expressions — just the stated
    binary equalities. If the text contains no checkable arithmetic it passes
    (this is a soundness check, not a presence requirement).
    """

    def _verify(text: str, task: Any, step: dict) -> dict:
        wrong: list[str] = []
        checked = 0
        for a, op, b, c in _ARITH.findall(text):
            x, y, z = float(a), float(b), float(c)
            if op in ("*", "×", "x"):
                got = x * y
            elif op == "/":
                if y == 0:
                    continue
                got = x / y
            elif op == "+":
                got = x + y
            else:
                got = x - y
            checked += 1
            if abs(got - z) > tol:
                wrong.append(f"{a} {op} {b} = {c} (actual {got:g})")
        if wrong:
            return _fail([f"false arithmetic: {w}" for w in wrong], {"wrong": wrong, "checked": checked})
        return _ok({"checked": checked})

    return _verify


# --------------------------------------------------------------------------- #
# Symbolic math (optional sympy backend, fail-closed) — the math analogue of
# code_tests_pass: a deterministic checker, no LLM judge.
# --------------------------------------------------------------------------- #
def _read_braced(s: str, i: int) -> "tuple[str, int] | None":
    """If ``s[i]`` opens a brace group, return ``(inner, index_after_close)`` for the
    BALANCED ``{...}`` group; else ``None``. Depth-counted, so a group whose inner text
    itself contains braces (``\\frac{2e^{3x}}{3}``) is read whole — unlike a ``[^{}]+``
    regex that stops at the first inner brace."""
    if i >= len(s) or s[i] != "{":
        return None
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                return (s[i + 1:j], j + 1)
    return None  # unbalanced -> caller leaves the token as-is (fails to parse => held)


def _rewrite_latex_groups(s: str) -> str:
    """``\\frac{a}{b}`` -> ``((a)/(b))`` and ``\\sqrt{a}`` -> ``sqrt((a))`` with BALANCED
    braces, recursing into each argument so a nested ``\\frac`` or ``e^{..}`` numerator
    parses (fixes the one-level-regex miss on ``\\frac{2e^{3x}}{3}``). An explicit ``*`` is
    inserted before a group that abuts a preceding alnum/``)`` so ``x\\frac..`` is a product,
    not a glued token. Value-preserving; an unbalanced token is left as-is (=> fails to
    parse, held, never a false accept)."""
    out: list[str] = []
    i, n = 0, len(s)

    def _mul_prefix() -> str:
        tail = out[-1][-1:] if out and out[-1] else ""
        return "*" if (tail.isalnum() or tail == ")") else ""

    while i < n:
        if s.startswith(r"\frac", i):
            j = i + 5
            while j < n and s[j] == " ":
                j += 1
            num = _read_braced(s, j)
            if num is not None:
                a, j = num
                while j < n and s[j] == " ":
                    j += 1
                den = _read_braced(s, j)
                if den is not None:
                    b, j = den
                    out.append(_mul_prefix() + "((" + _rewrite_latex_groups(a)
                               + ")/(" + _rewrite_latex_groups(b) + "))")
                    i = j
                    continue
        if s.startswith(r"\sqrt", i):
            j = i + 5
            while j < n and s[j] == " ":
                j += 1
            grp = _read_braced(s, j)
            if grp is not None:
                a, j = grp
                out.append(_mul_prefix() + "sqrt((" + _rewrite_latex_groups(a) + "))")
                i = j
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def _latex_to_sympy(expr: str) -> str:
    """Rewrite common LaTeX math notation into ``parse_expr``-readable syntax.

    NOTATION-ONLY and value-preserving: every rewrite here changes how an
    expression is written, never what it equals (``\\frac{a}{b}`` -> ``((a)/(b))``,
    ``\\sin`` -> ``sin``, ``e^{x}`` -> ``exp(x)``, ``\\cdot`` -> ``*``, braces ->
    parens). It is applied ONLY as a fallback after a raw parse fails (see
    ``_sympy_parse``), so it can never alter an already-parseable input, and because
    equality downstream is still exact symbolic ``simplify(a-b)==0``, a WRONG answer
    stays wrong after normalization — the worst a bad rewrite can do is fail to parse
    (held), never mint a false accept. This is the fix for the verifier's LaTeX
    blindness: models answer ``-2x \\sin(x^2)`` where the gold is ``-2*x*sin(x**2)``.
    """
    s = expr
    # spacing / delimiter noise
    for junk in (r"\left", r"\right", r"\,", r"\!", r"\;", r"\ ", r"\quad", r"\qquad"):
        s = s.replace(junk, " ")
    s = s.replace(r"\cdot", "*").replace(r"\times", "*").replace(r"\div", "/")
    # \frac / \sqrt with BALANCED braces (recurses into nested args like \frac{2e^{3x}}{3},
    # which the old one-level [^{}]+ regex could not match -> the \frac stayed unparsed).
    s = _rewrite_latex_groups(s)
    # named functions / constants: strip the backslash so \sin -> sin. If the control
    # sequence ABUTS a preceding alnum or ')', insert an explicit '*' first, so the STANDARD
    # no-space rendering 'x\sin' becomes 'x*sin' (implicit product) rather than 'xsin' —
    # which implicit_multiplication_application's split_symbols shatters into x*s*i*n, a
    # garbage expression that never equals the gold (a silent CORRECT->rejected under-count
    # on forms like '-2x\sin(x^2)'). '*' only replaces a backslash that already denoted
    # juxtaposition (a product), so it is value-preserving and mints no false accept.
    # \ln,\lg -> log (natural log). Longest names first so \arcsin is not split by \sin.
    for src, dst in (
        ("arcsin", "asin"), ("arccos", "acos"), ("arctan", "atan"),
        ("sinh", "sinh"), ("cosh", "cosh"), ("tanh", "tanh"),
        ("sin", "sin"), ("cos", "cos"), ("tan", "tan"), ("cot", "cot"),
        ("sec", "sec"), ("csc", "csc"), ("exp", "exp"), ("log", "log"),
        ("ln", "log"), ("lg", "log"), ("sqrt", "sqrt"), ("pi", "pi"),
    ):
        s = re.sub(r"(?<=[A-Za-z0-9)])\\" + src + r"(?![A-Za-z])", "*" + dst, s)
        s = re.sub(r"\\" + src + r"(?![A-Za-z])", dst, s)
    # Superscripts: a^{b} -> a**(b) ; bare a^b is handled by convert_xor after braces
    # go. Euler's e^{..}/e^x needs NO special case here: bare ``e`` binds to E in
    # _sympy_parse, so convert_xor turns e^x -> E**x = exp(x) and e^{2x} normalizes
    # to E**(2*x). (An earlier greedy ``e^([A-Za-z0-9]+)`` rewrite was UNSOUND: it
    # turned ``e^2x`` = (e**2)*x into exp(2*x); removed.)
    s = re.sub(r"\^\s*\{([^{}]+)\}", r"**(\1)", s)
    # Subscripts denote DISTINCT indexed variables (x_2 is NOT x). PRESERVE them as
    # a symbol-name suffix, never delete them — deleting ``x_{2}`` -> ``x`` is a
    # value change that mints false accepts. A non-simple subscript is left as
    # ``_{...}`` -> ``_(...)`` below, which fails to parse (held), never accepted.
    s = re.sub(r"_\s*\{([A-Za-z0-9]+)\}", r"_\1", s)
    # remaining LaTeX braces are grouping -> parens; drop any stray backslashes
    s = s.replace("{", "(").replace("}", ")").replace("\\", "")
    return s


def _sympy_parse(expr: str):
    """Parse one math expression with sympy. Returns (ok, sympy_expr_or_None).

    Uses ``parse_expr`` (not ``sympify`` / ``eval``) with explicit transformations
    so ``^`` means power and ``2x`` means ``2*x`` — math notation, not Python.
    Returns (False, None) when sympy is unavailable OR the string does not parse
    as a math expression (so prose like ``x = the answer`` is simply skipped, not
    flagged). Input is length-capped as a cheap guard against pathological strings.

    A raw parse is tried FIRST (so already-parseable inputs are byte-for-byte
    unchanged — zero regression); only if that fails is the LaTeX normalization
    fallback attempted (``_latex_to_sympy``), which is how ``-2x \\sin(x^2)`` and
    ``\\frac{1}{2} e^{2x}`` now parse to their sympy equivalents.
    """
    expr = (expr or "").strip()
    if not expr or len(expr) > 512:
        return (False, None)
    try:
        from sympy.parsing.sympy_parser import (
            convert_xor,
            implicit_multiplication_application,
            parse_expr,
            standard_transformations,
        )
    except Exception:  # noqa: BLE001 - sympy is an optional dependency
        return (False, None)
    trans = standard_transformations + (implicit_multiplication_application, convert_xor)
    # In this math-answer domain a bare ``e`` denotes Euler's number (models write
    # ``e^x`` for ``exp(x)``); gold answers use ``exp`` and never a bare-``e``
    # variable, so binding e->E fixes ``e^x`` vs ``exp(x)`` without changing any
    # gold-side parse. Equality downstream stays exact, so this cannot mint a false
    # accept (a wrong ``e^{2x}`` is E**(2x) != exp(x)).
    try:
        from sympy import E as _EULER
        local = {"e": _EULER}
    except Exception:  # noqa: BLE001
        local = {}
    try:
        return (True, parse_expr(expr, transformations=trans, local_dict=local, evaluate=True))
    except Exception:  # noqa: BLE001 - raw parse failed; try the LaTeX fallback
        pass
    try:
        normalized = _latex_to_sympy(expr)
        if not normalized.strip():
            return (False, None)
        return (True, parse_expr(normalized, transformations=trans, local_dict=local, evaluate=True))
    except Exception:  # noqa: BLE001 - still unparseable => "not a math claim", skip
        return (False, None)


def _sympy_equal(a_expr: str, b_expr: str) -> "bool | None":
    """True/False if a==b symbolically, or None if either side is not parseable.

    Symbolic first (``simplify(a-b)==0``); falls back to a SOUNDNESS-PRESERVING
    numeric probe for expressions ``simplify`` cannot close (transcendental
    tangles): a seeded PRNG over a wide rational range, >= 8 points per symbol, a
    polynomial degree guard, and two independent batches for transcendental diffs
    (see the block below). None means "can't decide" (treated as skip/held by
    callers), never a silent pass.
    """
    ok_a, ea = _sympy_parse(a_expr)
    ok_b, eb = _sympy_parse(b_expr)
    if not (ok_a and ok_b):
        return None
    try:
        import sympy as sp

        diff = sp.simplify(ea - eb)
        if diff == 0:
            return True
        # simplify can leave a nonzero-looking-but-zero residue; try a second pass.
        if sp.simplify(sp.expand(diff)) == 0:
            return True
        # --- Numeric fallback over the free symbols (decides most residual cases). ---
        # HARDENING (was: 4 FIXED points 0.5/1.5/2.5/-1.3; a wrong answer whose
        # gold-difference has roots exactly there passed — proven exploit
        # gold=sin(x), wrong=sin(x)+(x-0.5)(x-1.5)(x-2.5)(x+1.3)). The scheme below
        # is soundness-preserving: a SEEDED PRNG over a wide rational range, >= 8
        # points per symbol, a POLYNOMIAL DEGREE GUARD, and TWO independent random
        # batches for transcendental diffs. Undecidable cheaply => None (held),
        # never a silent True.
        syms = sorted(diff.free_symbols, key=str)
        if not syms:
            try:
                return abs(complex(diff)) < 1e-9
            except Exception:  # noqa: BLE001
                return False
        # Bound the symbol count purely to keep cost predictable (the probe is now
        # O(points), not O(points**n), so this cap is generous, not a soundness gate).
        if len(syms) > 8:
            return None
        import random

        n = len(syms)
        # (a) >= 8 points per symbol; floor of 16 so 1-symbol diffs still probe well.
        per_batch = max(8 * n, 16)

        # (c) DEGREE GUARD. If the difference is a polynomial, a nonzero degree-d
        # polynomial can vanish at up to d points, so sampling <= d points can NEVER
        # soundly certify either equal or not-equal (a wrong answer could plant its
        # roots at exactly the sample set). We therefore require per_batch > degree
        # before trusting the probe; otherwise we HOLD (None). When per_batch > d,
        # a nonzero poly CANNOT survive all-zero (it has < per_batch roots), so an
        # all-zero probe is a SOUND certificate of the zero polynomial -> True.
        try:
            poly = sp.Poly(diff, *syms)
            degree = poly.total_degree()
        except Exception:  # noqa: BLE001 - not a polynomial (transcendental)
            degree = None
        if degree is not None and per_batch <= degree:
            return None  # too few points to soundly decide this polynomial -> held

        def _batch_zero(seed: int) -> "bool | None":
            """Probe one seeded batch of rational points; True=all-zero, False=saw a
            nonzero value, None=undefined at every point (undecidable)."""
            rng = random.Random(seed)
            decided = False
            for _ in range(per_batch):
                subs = {
                    s: sp.Rational(rng.randint(-99, 99), rng.randint(1, 99))
                    for s in syms
                }
                try:
                    val = complex(diff.subs(subs))
                except Exception:  # noqa: BLE001 - undefined at this point, try next
                    continue
                decided = True
                if abs(val) > 1e-9:
                    return False
            return True if decided else None

        # For polynomials a single batch is a sound certificate (per_batch > degree,
        # guarded above). For transcendental diffs we (b) require agreement across
        # TWO independent seeded batches before returning True, so a wrong answer
        # would need its nonzero residue to vanish across both random point sets.
        r1 = _batch_zero(20240711)
        if r1 is False:
            return False
        if degree is not None:
            return r1  # single batch is sound for polynomials
        r2 = _batch_zero(20240809)
        if r2 is False:
            return False
        # Both batches all-zero (or both undecided) -> equal / held, never a guess.
        return True if (r1 is True and r2 is True) else None
    except Exception:  # noqa: BLE001 - solver error => undecided
        return None


# Multi-letter runs allowed inside a math expression (functions/constants).
# Anything else multi-letter (e.g. "Note", "apples", "general") means the captured
# side is prose, not math -> not an identity claim, so math_sound skips it.
_MATH_WORDS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "asin", "acos", "atan",
    "sinh", "cosh", "tanh", "log", "ln", "exp", "sqrt", "abs", "pi", "e",
    "oo", "re", "im", "deg", "rad", "gcd", "lcm", "mod",
}


def _is_math_atom(tok: str) -> bool:
    """A token belongs in a math expression: a number, operator, paren, single-letter
    variable, or a known function/constant. A multi-letter prose word is not."""
    if not tok.strip():
        return True  # whitespace is fine inside an expression
    if re.fullmatch(r"\d+\.?\d*", tok) or tok in ("**", "+", "-", "*", "/", "^", "(", ")"):
        return True
    if re.fullmatch(r"[A-Za-z]+", tok):
        return len(tok) == 1 or tok.lower() in _MATH_WORDS
    return False


_TOK = re.compile(r"\*\*|\d+\.?\d*|[A-Za-z]+|[()+\-*/^]|\s+")


def _math_core(side: str, *, keep: str) -> str:
    """Return the math expression adjacent to the '=' sign, trimming prose.

    ``keep='right'`` keeps the leading math run of a RHS (math is next to '=' on
    the left of the side); ``keep='left'`` keeps the trailing math run of a LHS.
    A side that is all prose returns ''. This is what lets math_sound read the
    algebra out of ``"In general, (x+1)**2 = x**2 + 1 always."`` without choking on
    the surrounding words."""
    toks = _TOK.findall(side)
    if keep == "left":
        toks = list(reversed(toks))
    core: list[str] = []
    for tok in toks:
        if _is_math_atom(tok):
            core.append(tok)
        elif core:
            break  # hit prose after starting the math run -> stop
        else:
            continue  # leading prose before the math run -> skip
    if keep == "left":
        core = list(reversed(core))
    out = "".join(core).strip()
    # Require real math content, not just a lone variable or stray paren.
    return out if re.search(r"[\d]|[+\-*/^]|\*\*", out) else ""


def _extract_boxed(text: str) -> "list[str]":
    """All ``\\boxed{...}`` contents via BALANCED brace matching, in order. Handles
    arbitrarily nested braces (``\\boxed{\\frac{2e^{3x}}{3}}``) that the one-level
    ``_BOXED`` regex misses (it would fail to match and the caller fell through to a
    last-line heuristic that returned the raw ``\\boxed{...}`` string -> parser garbage
    -> a correct answer scored 0)."""
    results: list[str] = []
    key = "\\boxed"
    idx = 0
    while True:
        p = text.find(key, idx)
        if p < 0:
            break
        j = p + len(key)
        while j < len(text) and text[j] == " ":
            j += 1
        grp = _read_braced(text, j)
        if grp is None:
            idx = p + len(key)
            continue
        results.append(grp[0])
        idx = grp[1]
    return results


def _split_equalities(text: str) -> "list[tuple[str, str]]":
    """Yield (left, right) text segments around each '=' within a sentence.

    Splits on sentence boundaries first so an equality never spans two sentences,
    then pairs consecutive parts so a chain ``a = b = c`` yields (a,b) and (b,c).
    The math core is extracted from each segment by ``_math_core``."""
    pairs: list[tuple[str, str]] = []
    for sentence in re.split(r"[.\n;:,]", text):
        if "=" not in sentence:
            continue
        # Ignore comparison/relational operators, keep plain '='.
        clean = re.sub(r"[<>!]=|=>|=<", " ", sentence)
        parts = clean.split("=")
        for i in range(len(parts) - 1):
            pairs.append((parts[i], parts[i + 1]))
    return pairs


def extract_math_answer(text: str) -> "str | None":
    """Pull a final math answer: a ``\\boxed{...}`` (MATH dataset convention),
    else a trailing ``answer is X`` / ``= X`` expression, else the last line."""
    if not text:
        return None
    boxed = _extract_boxed(text)
    if boxed:
        return boxed[-1].strip()
    # Stop at a SENTENCE-ending period (followed by space/end), not a decimal point.
    m2 = re.search(r"(?:answer|result)\s*(?:is|:|=)\s*(.+?)(?=\.\s|\.$|$)", text, re.IGNORECASE)
    if m2:
        return m2.group(1).strip()
    last = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return last[-1] if last else None


def _math_decided_by(cand: str, expected: str) -> str:
    """Label which decision path ``_sympy_equal`` took, for audit transparency.

    Returns one of ``symbolic | latex-fallback | numeric | undecidable | unparseable``,
    reconstructed from the same building blocks ``_sympy_equal`` uses (so the label
    matches the actual decision, not a parallel reimplementation). This is the
    deferred ``decidedBy`` field: every ``math_equivalent`` verdict now records HOW
    it was decided, and numeric-decided verdicts (the probabilistic path) are
    auditable at a glance.

    Post-#908, ``_sympy_parse`` tries a RAW ``parse_expr`` first and falls back to
    ``_latex_to_sympy`` only on failure. We replicate that two-step probe to label
    the *parse* path (raw vs latex-fallback), then probe ``simplify`` (symbolic)
    vs the numeric fallback to label the *equality* path.
    """
    ok_a, ea = _sympy_parse(cand)
    ok_b, eb = _sympy_parse(expected)
    if not (ok_a and ok_b):
        return "unparseable"
    # Determine the parse path: did a RAW parse_expr succeed on the candidate, or
    # did it need the LaTeX fallback? (Mirrors _sympy_parse's two-step structure.)
    parse_path = "raw-parse"
    try:
        from sympy.parsing.sympy_parser import (  # noqa: PLC0415
            convert_xor,
            implicit_multiplication_application,
            parse_expr,
            standard_transformations,
        )
        from sympy import E as _EULER  # noqa: PLC0415

        trans = standard_transformations + (implicit_multiplication_application, convert_xor)
        local = {"e": _EULER}
        try:
            parse_expr(cand, transformations=trans, local_dict=local, evaluate=True)
        except Exception:  # noqa: BLE001 - raw failed -> the LaTeX fallback was used
            parse_path = "latex-fallback"
    except Exception:  # noqa: BLE001 - sympy unavailable shouldn't reach here (ok_* guard)
        pass
    # Determine the equality path: symbolic (simplify closed) vs numeric.
    import sympy as sp  # noqa: PLC0415

    # This is a DIAGNOSTIC label only; it must NEVER crash the verdict. A candidate
    # that parses to a non-scalar (e.g. a sympy Tuple from "1, 2") makes ``ea - eb``
    # raise TypeError — catch everything and degrade to "undecidable".
    try:
        diff = sp.simplify(ea - eb)
        if diff == 0 or sp.simplify(sp.expand(diff)) == 0:
            return "latex-fallback" if parse_path == "latex-fallback" else "symbolic"
        # simplify did not close -> the numeric probe decided it (equal OR unequal);
        # either way the DECISION PATH is numeric, not symbolic.
        eq = _sympy_equal(cand, expected)
        return "undecidable" if eq is None else "numeric"
    except Exception:  # noqa: BLE001 - a label must never break verification
        return "undecidable"


def math_equivalent(expected: str, *, extract: bool = True) -> Verifier:
    """Pass iff the answer is SYMBOLICALLY equal to ``expected`` (sympy).

    The math analogue of ``exact_match`` but modulo algebra: ``2*x`` ≡ ``x + x``,
    ``1/2`` ≡ ``0.5``, ``(x-1)*(x+1)`` ≡ ``x**2 - 1``. By default it first extracts
    a final answer (``\\boxed{}`` / "answer is …" / last line); pass
    ``extract=False`` to compare the whole string. Intended as an eval / RLVR
    reward seam (MATH-style problems).

    **Fail-closed (optional dependency).** When sympy is unavailable the run is not
    verifiable, so it FAILS with reason ``sympy_unavailable`` (a held verdict),
    never a silent pass — mirroring the z3 formal verifier.
    """
    def _verify(text: str, task: Any, step: dict) -> dict:
        try:
            import sympy  # noqa: F401
        except Exception:  # noqa: BLE001
            return _fail(["sympy_unavailable: cannot verify math equivalence"],
                         {"checked": 0, "sympy": False})
        cand = extract_math_answer(text) if extract else (text or "").strip()
        if not cand:
            return _fail(["no math answer found in response"], {"sympy": True})
        eq = _sympy_equal(cand, expected)
        decided_by = _math_decided_by(cand, expected)
        if eq is True:
            return _ok({"expected": expected, "got": cand, "sympy": True,
                        "decidedBy": decided_by})
        if eq is None:
            return _fail([f"unparseable math (expected {expected!r}, got {cand!r})"],
                         {"expected": expected, "got": cand, "sympy": True,
                          "decidedBy": decided_by})
        return _fail([f"not equivalent: got {cand!r}, expected {expected!r}"],
                     {"expected": expected, "got": cand, "sympy": True,
                      "decidedBy": decided_by})

    return _verify


def math_sound() -> Verifier:
    """Fail if the text states a FALSE math identity (the symbolic ``arithmetic_sound``).

    Always runs the pure-Python ``arithmetic_sound`` check (no dependency). When
    sympy is present it ADDITIONALLY verifies stated *algebraic* equalities
    (``(x+1)**2 = x**2 + 1`` → flagged; ``x**2 - 1 = (x-1)(x+1)`` → fine). When
    sympy is absent it degrades gracefully to arithmetic-only and records how many
    algebraic claims went unverified in ``detail.heldClaims`` (so the gate can
    escalate) — it never blocks a valid answer just because the optional backend is
    missing, and it never silently passes a false one it actually checked.
    """
    arith = arithmetic_sound()

    def _verify(text: str, task: Any, step: dict) -> dict:
        base = arith(text, task, step)
        wrong = list((base.get("detail") or {}).get("wrong") or [])
        checked = int((base.get("detail") or {}).get("checked") or 0)
        held = 0
        try:
            import sympy  # noqa: F401
            have_sympy = True
        except Exception:  # noqa: BLE001
            have_sympy = False
        for lhs_raw, rhs_raw in _split_equalities(text or ""):
            a = _math_core(lhs_raw, keep="left")
            b = _math_core(rhs_raw, keep="right")
            if not (a and b):
                continue
            # Skip pure-number equalities (arithmetic_sound owns those); we want the
            # ALGEBRAIC ones (a letter on at least one side).
            if not re.search(r"[A-Za-z]", a + b):
                continue
            if not have_sympy:
                held += 1
                continue
            eq = _sympy_equal(a, b)
            if eq is None:
                continue  # not a decidable identity -> not flagged
            checked += 1
            if eq is False:
                wrong.append(f"{a} = {b} (not an identity)")
        if wrong:
            return _fail([f"false math: {w}" for w in wrong],
                         {"wrong": wrong, "checked": checked, "sympy": have_sympy, "heldClaims": held})
        return _ok({"checked": checked, "sympy": have_sympy, "heldClaims": held})

    return _verify


# --------------------------------------------------------------------------- #
# Physics (pure-Python SI units, no optional backend) — the physics analogue of
# math_equivalent: dimensional analysis + numeric tolerance is the ground truth.
# "9.8 J" is NOT "9.8 m/s^2"; right number, wrong units => rejected.
# --------------------------------------------------------------------------- #
_QTY = re.compile(r"[+-]?\d[\d.]*(?:[eE][+-]?\d+)?\s*[A-Za-zΩµμ][A-Za-zΩµμ0-9.^*/·\-]*")


def physics_equivalent(expected: str, *, rtol: float = 1e-2, extract: bool = True) -> Verifier:
    """Pass iff the answer is the same PHYSICAL quantity as ``expected``: identical
    SI dimension AND value within relative tolerance ``rtol`` (default 1%).

    The physics analogue of ``math_equivalent``. Dimensional analysis is the seam:
    ``30 N`` ≡ ``30 kg*m/s**2`` (accepted), but ``30 J`` is a dimension mismatch
    (rejected) and ``31 N`` is off by >1% (rejected). When ``expected`` carries no
    number (a symbolic gold like ``sqrt(2*g*h)``) it falls back to
    ``math_equivalent`` (sympy). **Fail-closed:** an unparseable candidate FAILS
    (a held verdict), never a silent pass. Units are pure-Python — no GPU, no
    optional dependency — so this is the math/code RLVR pattern extended to physics.
    """
    from agent import units

    def _verify(text: str, task: Any, step: dict) -> dict:
        cand = extract_math_answer(text) if extract else (text or "").strip()
        if not cand:
            return _fail(["no answer found in response"], {"expected": expected})
        ok_g, gval, gdim = units.parse_quantity(expected)
        if not ok_g:
            # Symbolic gold (no number) — defer to the algebraic oracle.
            return math_equivalent(expected, extract=False)(cand, task, step)
        ok_c, cval, cdim = units.parse_quantity(cand)
        if not ok_c:
            return _fail([f"unparseable quantity: {cand!r}"], {"expected": expected, "got": cand})
        if not units.same_dim(gdim, cdim):
            return _fail(
                [f"dimension mismatch: got {units.format_dim(cdim)}, expected {units.format_dim(gdim)}"],
                {"expected": expected, "got": cand,
                 "expectedDim": units.format_dim(gdim), "gotDim": units.format_dim(cdim)},
            )
        denom = abs(gval) if gval != 0 else 1.0
        rel = abs(cval - gval) / denom
        if rel <= rtol:
            return _ok({"expected": expected, "got": cand, "relErr": rel, "dim": units.format_dim(gdim)})
        return _fail([f"value off by {rel:.3g} (rtol {rtol:g})"],
                     {"expected": expected, "got": cand, "relErr": rel})

    return _verify


def physics_sound(*, rtol: float = 1e-2) -> Verifier:
    """Fail if the text states a dimensionally-false unit equality (e.g. ``1 J = 1
    kg*m/s^2`` — energy is ``kg*m^2/s^2``, so the units don't balance).

    The unit-bearing analogue of ``arithmetic_sound``: it only fires on stated
    equalities where BOTH sides parse as a quantity and at least one carries a real
    dimension (pure-number equalities belong to ``arithmetic_sound``; prose is
    skipped). Catches the classic physics error of a wrong unit conversion or a
    dimensionally-inconsistent step, with no model and no false-positive on plain
    text. Pure-Python, always available.
    """
    from agent import units

    def _verify(text: str, task: Any, step: dict) -> dict:
        wrong: list[str] = []
        checked = 0
        for left, right in _split_equalities(text or ""):
            lm = list(_QTY.finditer(left))
            rm = list(_QTY.finditer(right))
            if not lm or not rm:
                continue
            ls, rs = lm[-1].group(0).strip(), rm[0].group(0).strip()
            okl, lv, ld = units.parse_quantity(ls)
            okr, rv, rd = units.parse_quantity(rs)
            if not (okl and okr):
                continue
            if ld == units.ZERO and rd == units.ZERO:
                continue  # arithmetic_sound owns pure-number equalities
            checked += 1
            if not units.same_dim(ld, rd):
                wrong.append(f"{ls} = {rs} (dimension mismatch)")
                continue
            denom = abs(lv) if lv != 0 else 1.0
            if abs(lv - rv) / denom > rtol:
                wrong.append(f"{ls} = {rs} (value mismatch)")
        if wrong:
            return _fail([f"false physics: {w}" for w in wrong], {"wrong": wrong, "checked": checked})
        return _ok({"checked": checked})

    return _verify


def no_secret_leak(secrets: "list[str]", *, mask: bool = True) -> Verifier:
    """Fail if any classified/canary value appears verbatim in the text.

    A deterministic confidentiality tripwire: exact-substring match against a list
    of secret values/canaries — no model, no heuristics, so "blocked" means
    blocked. This is the minimal egress check the injection red-team motivates.

    Scope (honest): it catches *verbatim* leakage only. It does NOT understand
    paraphrase, partial disclosure, or encoding — which is exactly why the roadmap
    pairs it with out-of-prompt taint tracking (CaMeL-style). Use it as a tripwire
    in depth, not as a standalone guarantee. The detail never echoes the secret.
    """
    toks = [s for s in (secrets or []) if s]

    def _verify(text: str, task: Any, step: dict) -> dict:
        body = text or ""
        leaked = [s for s in toks if s in body]
        if leaked:
            shown = [(s[:4] + "…") if mask else s for s in leaked]
            return _fail([f"secret value leaked: {m}" for m in shown], {"leakedCount": len(leaked)})
        return _ok({"secretsChecked": len(toks)})

    return _verify


def legal_citation_exists(
    known_authorities: "set | None" = None,
    *,
    require_citation: bool = False,
    resolver: "Callable[[str], Any] | None" = None,
) -> Verifier:
    """Fail if the answer cites a legal authority that is NOT in a trusted source.

    This is the *Mata v. Avianca* / *Ayinde v Haringey* killer: every common-law
    **neutral citation** (``[2025] HKCFI 808``) and HK **ordinance** ref
    (``Cap. 614``) in the text is checked against a register of authorities that
    actually exist. An unrecognized citation is treated as fabricated and fails —
    **fail-closed**, so an empty/missing register flags every citation rather than
    waving fabrications through.

    A citation absent from the static register is given a second chance via the
    optional ``resolver`` (``agent.legal_sources.make_resolver``) — a cache-first
    HKLII / e-Legislation lookup that returns a ``Resolution``; only a
    ``verified=True`` result clears it. Still fail-closed: any non-verified
    resolution (not found / offline / network error) remains a violation.

    With ``require_citation`` an answer that makes a case-law-style assertion
    ("the court held ...") while citing nothing is also flagged.

    Scope (honest, mirrors the legal-AI literature): this verifies *existence*
    only. It does NOT confirm the authority is in the right jurisdiction, that the
    holding supports the proposition, or that the law is current — the three-part
    check a human must still perform. Populate the register from an authoritative
    primary source via ``SOPHIA_LEGAL_AUTHORITIES`` / the live resolver; the
    bundled snapshot is illustrative only.
    """
    from agent.legal_citations import extract_citations, load_known_authorities

    known = known_authorities if known_authorities is not None else load_known_authorities()

    def _resolves(citation: str) -> bool:
        if resolver is None:
            return False
        try:
            res = resolver(citation)
        except Exception:  # fail-closed: a broken resolver never passes a citation
            return False
        return bool(getattr(res, "verified", False) or (isinstance(res, dict) and res.get("verified")))

    def _verify(text: str, task: Any, step: dict) -> dict:
        cites = extract_citations(text or "")
        violations = [c for c in cites if c not in known and not _resolves(c)]
        if require_citation and not cites and (
            re.search(r"\b(?:the court (?:held|found|ruled)|it was held)\b", text or "", re.IGNORECASE)
            or re.search(r"[A-Z][a-z]+ v\.? [A-Z]", text or "")
        ):
            violations.append("legal assertion with no citation")
        if violations:
            return _fail(
                [f"unverified/fabricated legal citation: {v}" for v in violations],
                {"violations": violations, "checked": len(cites), "registerSize": len(known)},
            )
        return _ok({"checked": len(cites), "registerSize": len(known)})

    return _verify


def legal_holding_faithful(*, holding_for=None, judge=None, require_support: bool = False) -> Verifier:
    """Fail if a cited authority is MISSTATED — its holding does not support the
    proposition it is cited for (the *Ayinde* misstated-authority failure).

    This is the semantic tier above ``legal_citation_exists``: it judges support,
    not mere existence, so it needs an LLM ``judge`` (``agent.legal_faithfulness``).
    Fail-closed and abstaining — a pair with no authoritative holding text, or that
    the judge cannot decide, is reported as **abstained** (unchecked), never passed.
    A ``contradicted`` verdict (real authority, wrong proposition) is the violation.

    By default ``passed`` is True iff nothing is contradicted (it flags affirmative
    misuse and surfaces what it could not check). With ``require_support`` an
    abstention is also a hard fail (full fail-closed).

    Honest scope: the support judgment is a model call — measure it under the
    no-overclaim gate (≥2 independent judges + CIs); a single judge is illustrative,
    never a headline. Tests inject a deterministic stub judge to verify wiring only.
    """
    from agent.legal_faithfulness import assess_text

    def _verify(text: str, task: Any, step: dict) -> dict:
        result = assess_text(text, holding_for=holding_for, judge=judge)
        contradicted = result["contradicted"]
        abstained = result["abstained"]
        reasons = [f"misstated authority {c['citation']}: {c.get('reason', '')}".strip() for c in contradicted]
        if require_support:
            reasons += [f"unverifiable support for {a['citation']}: {a.get('why', '')}".strip() for a in abstained]
        detail = {
            "supported": result["supported"],
            "contradicted": contradicted,
            "abstained": abstained,
        }
        return _ok(detail) if not reasons else _fail(reasons, detail)

    return _verify


# --------------------------------------------------------------------------- #
# OKF / provenance verifiers — encode "don't merge lineages" as a hard gate.
# --------------------------------------------------------------------------- #


# Env var letting a user enforce their OWN attribution rules (legal/corporate/code
# provenance) through the same machine-checked gate, beyond the seeded domains.
# Value is a directory (its *.json), a glob, a single file, or several of these
# joined by the OS path separator.
_DISCIPLINE_RECORDS_ENV = "SOPHIA_DISCIPLINE_RECORDS"


def _merge_records(into: dict, data: object, *, source: str, warn_skips: bool = False) -> None:
    """Merge a ``{key: record}`` mapping into ``into``, keeping only records that
    carry a non-empty ``doNotAttributeTo`` list (the one field this gate enforces).
    With ``warn_skips`` (user-supplied files), emit a warning for each skip so a
    malformed record is visible rather than silently ignored."""
    if not isinstance(data, dict):
        warnings.warn(f"discipline records in {source} are not a JSON object; skipped")
        return
    for key, record in data.items():
        if isinstance(record, dict) and record.get("doNotAttributeTo"):
            into[record.get("recordId") or record.get("textId") or key] = record
        elif warn_skips:
            warnings.warn(f"{source}: record '{key}' has no doNotAttributeTo; skipped")


def _user_record_paths() -> list[Path]:
    """Resolve ``SOPHIA_DISCIPLINE_RECORDS`` to a list of JSON files. Each entry
    may be a directory (its ``*.json``), a glob, or a single file."""
    spec = os.environ.get(_DISCIPLINE_RECORDS_ENV, "").strip()
    if not spec:
        return []
    paths: list[Path] = []
    for part in spec.split(os.pathsep):
        part = part.strip()
        if not part:
            continue
        p = Path(part).expanduser()
        if p.is_dir():
            paths.extend(sorted(p.glob("*.json")))
        elif p.exists():
            paths.append(p)
        else:
            matched = sorted(Path(m) for m in _glob(os.path.expanduser(part)))
            if matched:
                paths.extend(matched)
            else:
                warnings.warn(f"{_DISCIPLINE_RECORDS_ENV} path not found: {part}")
    return paths


def _load_provenance_records() -> dict:
    records: dict = {}
    for filename in _PROVENANCE_FILES:
        path = DATA_DIR / filename
        if not path.exists():
            continue
        _merge_records(records, json.loads(path.read_text(encoding="utf-8")), source=str(path))
    for path in _user_record_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            warnings.warn(f"could not load discipline records from {path}: {exc}")
            continue
        _merge_records(records, data, source=str(path), warn_skips=True)
    return records


# --- concept-TBox loaders (the doNotMergeWith / cross-tradition channel) ----- #
# The provenance loader above keeps ONLY records with doNotAttributeTo, so the
# concept-boundary data (records carrying doNotMergeWith) is dropped before the
# attribution gate ever sees it. These parallel loaders surface that data for the
# ontology gate (the fix the plan calls for at _merge_records). See
# docs/11-Platform/Ontology-Claim-Boundary.md.
_TRADITION_FILES = ("traditions.json", "religion_concepts.json")
_CONCEPT_LEXICON_FILE = "concept_traditions.json"


def _load_merge_records() -> dict:
    """Load every record carrying a non-empty ``doNotMergeWith`` list (the field
    the ontology gate enforces), keyed by record/tradition id. Parallel to
    :func:`_load_provenance_records`, which keeps only ``doNotAttributeTo``."""
    records: dict = {}
    for filename in _TRADITION_FILES:
        path = DATA_DIR / filename
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:  # malformed seed -> skip, not crash
            warnings.warn(f"could not load merge records from {path}: {exc}")
            continue
        if not isinstance(data, dict):
            continue
        for key, record in data.items():
            if isinstance(record, dict) and record.get("doNotMergeWith"):
                records[record.get("id") or record.get("recordId") or key] = record
    return records


def _load_dnm_by_tradition() -> dict:
    """Map a tradition id -> set of traditions it must not be merged with, unioned
    over traditions.json (per-tradition) and religion_concepts.json (per-record
    ``tradition`` + ``doNotMergeWith``). Used to flag a cross-tradition identity
    assertion as an *explicit* do-not-merge violation (vs a merely distinct pair)."""
    dnm: dict[str, set] = {}
    for record in _load_merge_records().values():
        trad = record.get("id") or record.get("tradition")
        if not trad:
            continue
        forbidden = {str(t).lower() for t in (record.get("doNotMergeWith") or [])}
        dnm.setdefault(str(trad).lower(), set()).update(forbidden)
    return dnm


def _load_concept_traditions() -> dict:
    """Load the concept->tradition lexicon (term -> tradition id). Drives the
    surface ontology gate so it can fire on a concept-level cross-tradition
    identity assertion (``ren is identical to agape``). Small, sourced, versioned;
    a closed-world lexicon, not a truth oracle (see data/concept_traditions.json)."""
    path = DATA_DIR / _CONCEPT_LEXICON_FILE
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        warnings.warn(f"could not load concept lexicon from {path}: {exc}")
        return {}
    concepts = data.get("concepts") if isinstance(data, dict) else None
    if not isinstance(concepts, dict):
        return {}
    out: dict[str, str] = {}
    for term, rec in concepts.items():
        if isinstance(rec, dict) and rec.get("tradition"):
            out[str(term).lower()] = str(rec["tradition"]).lower()
            zh = rec.get("labelZh")
            if zh:
                out[str(zh).lower()] = str(rec["tradition"]).lower()
    return out


# Clause boundaries for SCOPING the negation/correction carve-out. We split a
# sentence into clauses on contrastive connectors and a leading subordinate clause,
# but NOT on bare commas — commas hold appositives the gate must keep matching
# ("Enoch, the great-grandson of Adam, wrote ..."). This closes the negation-
# evasion the red-team found: a correction clause ("it is a myth, but ...") can no
# longer shield an assertion clause ("... Confucius wrote the Dao De Jing").
_CLAUSE_SPLIT = re.compile(
    r"\bbut\b|\bhowever\b|\byet\b|\bnevertheless\b|\bnonetheless\b|\bin truth\b|"
    r"\bin fact\b|\bin reality\b|\bactually\b|\bindeed\b|\brather\b|\binstead\b|"
    r"\btruth is\b|;|—|–"
)
_LEAD_SUBORD = re.compile(
    r"^\s*(?:contrary to|despite|although|though|while|whereas|unlike|far from|"
    r"notwithstanding|regardless of)\b[^,]{0,100},"
)


def _carveout_clauses(low: str) -> list:
    """Split a lowercased sentence into carve-out scopes: peel a leading
    subordinate clause (``Contrary to ... that he did not, X wrote Y``) then split
    on contrastive connectors. Commas inside the body are preserved so appositive
    author→title patterns still match."""
    head: list = []
    m = _LEAD_SUBORD.match(low)
    if m:
        head = [low[: m.end()]]
        low = low[m.end():]
    return [c for c in (head + _CLAUSE_SPLIT.split(low)) if c and c.strip()]


# Compiled-spec cache for provenance_faithful. Building the per-(record, author)
# patterns is ~0.3s / 765 re.compile calls for the 36-record corpus, and the gate
# is invoked once *per claim* (e.g. provenance_bench scores 300+ cases × 2 arms ×
# several tests), so rebuilding every call turned a fast verifier into a multi-minute
# CI hang. The compiled patterns depend only on the records' titles + doNotAttributeTo,
# so we memoise them under a content key. LRU-bounded so grounded mode (which
# synthesises fresh per-claim records) cannot grow the cache without limit.
_PROV_SPEC_CACHE: "OrderedDict[tuple, list]" = OrderedDict()
_PROV_SPEC_CACHE_MAX = 256


def _provenance_spec_key(records: dict) -> tuple:
    """Hashable key over exactly the record fields that determine the compiled specs."""
    return tuple(
        (
            rid,
            (records[rid] or {}).get("canonicalTitleEn"),
            (records[rid] or {}).get("canonicalTitleZh"),
            tuple((records[rid] or {}).get("altTitlesEn") or ()),
            tuple((records[rid] or {}).get("doNotAttributeTo") or ()),
        )
        for rid in sorted(records)
    )


def _build_provenance_specs(
    records: dict, *, attr: str, attr_p: str, app: str, the: str, the_q: str,
    conn: str, nm: str, author_markers: "Callable",
) -> list[tuple]:
    """Compile the per-(record, author) attribution patterns. Pure function of
    records + the (constant) regex fragments — safe to memoise by content key."""
    specs: list[tuple] = []
    for rid, record in records.items():
        titles = [
            str(t).lower()
            for t in (
                record.get("canonicalTitleEn"),
                record.get("canonicalTitleZh"),
                rid.replace("_", " "),
                *(record.get("altTitlesEn") or []),
            )
            if t and len(str(t)) >= 3
        ]
        if not titles:
            continue
        # longest titles first so "constitution of the athenians" wins over a substring
        titles = sorted(dict.fromkeys(titles), key=len, reverse=True)
        title_alt = "(?:" + "|".join(re.escape(t) for t in titles) + ")"
        for author in record.get("doNotAttributeTo", []):
            a = "(?:" + "|".join(re.escape(m.lower()) for m in author_markers(author)) + r")\b"
            t = title_alt + r"\b"
            # Explicit grammatical constructions of *asserted authorship*, in both
            # orders, with tight connectors only (no wildcard gap) so a comparison
            # ("Plato wrote Republic — not Socrates") or a possessive of a different
            # noun ("from Epictetus's teachings") does not cross-match.
            patterns = [
                re.compile(a + app + r"\s*" + attr + r"\s+" + the_q + t),                                # X (the …) wrote (the) "Y"
                re.compile(a + r"(?:\s+(?:is|was|being))?\s+" + the + r"(?:author|writer|composer)\s+of\s+" + the_q + t),  # X is the author of Y
                re.compile(a + app + r"\s*(?:is|was)\s+credited\s+with\s+\w+ing\s+" + the_q + t),        # X (the …) is credited with writing Y
                re.compile(a + r"['’]s\s+" + the_q + t),                                                 # X's (the) Y
                re.compile(conn + t + r"(?:\s*,)?(?:\s+(?:was|is|were|been))?\s+(?:" + attr_p + r"|attributed)\s+by\s+" + nm + a),  # Y (was) written/discovered by X
                re.compile(conn + t + r"(?:\s*,)?\s+(?:is|was|are|were|been|being)?\s*attributed\s+to\s+" + nm + a),  # Y is attributed to (the prophet) X
                re.compile(t + r"(?:\s*,)?\s+(?:a\s+|the\s+)?(?:work|text|book|composition|treatise)\s+(?:by|of)\s+" + a),  # Y, a work by X
                re.compile(t + r"\s+(?:was\s+|is\s+)?" + a + r"['’]s\s+(?:\w+\s+)?(?:work|text|masterpiece|composition|book|treatise)\b"),  # Y was X's work
                re.compile(a + r"\s*著\s*" + title_alt),                                                 # X 著 Y
            ]
            specs.append((rid, author, patterns))
    return specs


def provenance_faithful(records: "dict | None" = None, *, return_specs: bool = False) -> Verifier:
    """Fail if the text asserts an attribution forbidden by a record's
    doNotAttributeTo — Sophia's core "don't merge lineages" rule, machine-checked.

    Sentence-scoped with a negation/contrast carve-out (reusing the benchmark
    DENY/MYTH markers), so a page that CORRECTLY says "Confucius did not write the
    Dao De Jing" passes while "Confucius wrote the Dao De Jing" fails. Works on
    agent answers and on wiki page bodies alike.

    With ``return_specs=True`` the returned verifier carries a ``.specs``
    attribute — the compiled ``(rid, author, patterns)`` tuples it built. This is
    a read-only hook for the Datalog port (:mod:`agent.datalog_provenance`) to
    extract ground facts using the gate's OWN patterns; it changes nothing about
    the verdict path and stays out of the production decision.
    """
    from agent.benchmark_checks import DENY_PATTERNS, MYTH_PATTERNS, author_markers, matches_any

    records = records if records is not None else _load_provenance_records()
    the = r"(?:the\s+)?"
    q = r"[\"“”'’«»]?"                                     # an optional opening/closing quote
    # Bounded "theory/phrase/law of …" connector so a DISCOVERY can sit behind it
    # ("invented the theory of X", "coined the phrase Y"). Optional, so authorship
    # titles ("wrote the Republic") are unaffected.
    conn = r"(?:(?:the\s+)?(?:theor(?:y|em)|phrase|concept|idea|principle|law|notion|term|model)\s+of\s+)?"
    the_q = q + r"\s*" + the + q + r"\s*" + conn           # quote/"the"/connector-tolerant lead-in to a title
    # Authorship verbs PLUS discovery/coinage verbs, so the gate adjudicates "who
    # discovered/invented/coined X", not only "who wrote X" — the science domain's
    # attribution shape. Discovery verbs are conservative (no generic "made/created").
    _disc = r"|invented|discovered|coined|formulated|devised|originated|conceived|proposed"
    attr = r"(?:wrote|authored|penned|composed" + _disc + r")"          # active
    attr_p = r"(?:written|authored|penned|composed|invented|discovered|coined|formulated|devised|originated|conceived|proposed)"  # passive participle
    # Bounded honorific/article lead-in to a name ("to the prophet Daniel").
    nm = r"(?:(?:the|a|an|prophet|apostle|king|saint|st\.?|emperor|biblical|tyrant)\s+){0,3}"
    # Optional bounded appositive/parenthetical between an author and the verb:
    #   "Enoch, the great-grandson of Adam, wrote ...", "Lie Yukou (also known as
    #   Liezi) wrote ...". Length/punctuation-bounded and contrast-free (no "not"/
    #   "but") so it never bridges a correction.
    app = (
        r"(?:\s*\([^)]{0,50}\)"                                        # ( ... )
        r"|\s*,(?:(?!,|\bnot\b|\bbut\b)[^.;]){1,60},"                  # , ... ,
        r"|\s+(?:the|a|an)\s+(?!not\b|but\b)(?:[\w'’-]+\s+){1,5})?"    # the X of Y
    )
    # Skip non-assertions: instructions ("do not attribute X to Y"), reported/hedged
    # speech ("summaries say ...", "often said"), scare-quoted verbs ("wrote"), and
    # scholarly hedges that *correctly* flag a traditional/spurious attribution.
    extra_deny = [
        r"do not attribut", r"not\s+\w*\s*attribut", r"never\s+\w*\s*attribut",
        r"misattribut", r"wrongly", r"falsely", r"erroneous", r"並非", r"勿",
        r"summaries say", r'say[s]?\s+["“\']', r"often\s+said", r"commonly\s+(said|believed|attributed)",
        r"\bpopular", r"\bmisread", r"\bmistaken", r"\bloosely\b", r"\bas if\b", r"main speaker",
        r'["“\'](?:wrote|written|authored|composed|penned|attributed)["”\']',
        r"traditionally", r"\bspuri", r"pseudo[\s-]?", r"apocryphal", r"\bforg(?:ed|ery)",
        r"\bdisputed\b", r"\bdoubtful\b", r"\bdebated\b", r"scholars?\s+(?:doubt|reject|dispute|question)",
    ]

    # Compiled per-(record, author) patterns are content-memoised (see cache above):
    # rebuilding ~765 regexes on every claim was an O(claims) CI hang.
    _spec_key = _provenance_spec_key(records)
    specs = _PROV_SPEC_CACHE.get(_spec_key)
    if specs is not None:
        _PROV_SPEC_CACHE.move_to_end(_spec_key)
    else:
        specs = _build_provenance_specs(
            records, attr=attr, attr_p=attr_p, app=app, the=the, the_q=the_q,
            conn=conn, nm=nm, author_markers=author_markers,
        )
        _PROV_SPEC_CACHE[_spec_key] = specs
        if len(_PROV_SPEC_CACHE) > _PROV_SPEC_CACHE_MAX:
            _PROV_SPEC_CACHE.popitem(last=False)

    def _verify(text: str, task: Any, step: dict) -> dict:
        violations: list[str] = []
        for sentence in re.split(r"[.!?。！？\n]+", text):
            low = sentence.lower()
            if not low.strip():
                continue
            # Carve-out is CLAUSE-scoped: a correction/negation only excuses the
            # clause it lives in, so it cannot shield an asserting clause in the
            # same sentence (the negation-evasion the red-team surfaced).
            for clause in _carveout_clauses(low):
                if matches_any(clause, DENY_PATTERNS) or matches_any(clause, MYTH_PATTERNS) or matches_any(clause, extra_deny):
                    continue  # the correction/negation/instruction case — allowed
                for rid, author, patterns in specs:
                    if any(p.search(clause) for p in patterns):
                        violations.append(f"{author} -> {rid}")
        violations = sorted(set(violations))
        if violations:
            return _fail([f"forbidden attribution asserted: {v}" for v in violations], {"violations": violations})
        return _ok({"recordsChecked": len(records)})

    if return_specs:
        _verify.specs = specs  # type: ignore[attr-defined]  # read-only hook for the Datalog port
    return _verify


# Alias used in the brainstorm/docs.
source_discipline = provenance_faithful


def frontmatter_schema_valid() -> Verifier:
    """Pass if the text parses as an OKF page with schema-valid frontmatter."""

    def _verify(text: str, task: Any, step: dict) -> dict:
        from okf import frontmatter, schema

        meta, _ = frontmatter.parse(text)
        if not meta:
            return _fail(["no OKF frontmatter found"])
        errors = schema.validate_meta(meta)
        return _ok({"id": meta.get("id")}) if not errors else _fail(errors, {"frontmatter": meta})

    return _verify


def no_broken_wikilink(known_ids: list[str]) -> Verifier:
    """Pass if every [[wikilink]] in the text resolves to a known page id."""
    from okf import wikilinks

    known = {wikilinks.normalize_target(k) for k in known_ids}

    def _verify(text: str, task: Any, step: dict) -> dict:
        broken = [t for t in wikilinks.extract_links(text) if t not in known]
        return _ok() if not broken else _fail([f"broken wikilink: [[{t}]]" for t in sorted(set(broken))])

    return _verify


def wiki_consistent(roots: "list | None" = None) -> Verifier:
    """World-state verifier: the OKF wiki must be a clean provenance graph.

    Ignores `text` (like unit_test) — it grades the repository, not the answer.
    """

    def _verify(text: str, task: Any, step: dict) -> dict:
        from okf import linker

        paths = roots or [ROOT / "wiki", ROOT / "docs" / "04-Disputes"]
        existing = [p for p in paths if Path(p).exists()]
        report = linker.link_report(*existing)
        if report["ok"]:
            return _ok({"pages": report["pages"]})
        reasons = (
            [f"schema {e['page']}" for e in report["schemaErrors"]]
            + [f"dangling {d['page']}->[[{d['target']}]]" for d in report["danglingLinks"]]
            + [f"lineage-merge {m['page']}" for m in report["contradictions"]["selfMerges"]]
        )
        return _fail(reasons or ["wiki inconsistent"], {"pages": report["pages"]})

    return _verify


def all_of(*verifiers: Verifier) -> Verifier:
    def _verify(text: str, task: Any, step: dict) -> dict:
        reasons: list[str] = []
        detail: dict[str, Any] = {}
        passed = True
        for i, v in enumerate(verifiers):
            r = v(text, task, step)
            detail[f"v{i}"] = r.get("detail", {})
            if not r["passed"]:
                passed = False
                reasons.extend(r["reasons"])
        return {"passed": passed, "reasons": reasons, "detail": detail}

    return _verify


def any_of(*verifiers: Verifier) -> Verifier:
    def _verify(text: str, task: Any, step: dict) -> dict:
        all_reasons: list[str] = []
        for v in verifiers:
            r = v(text, task, step)
            if r["passed"]:
                return _ok(r.get("detail", {}))
            all_reasons.extend(r["reasons"])
        return _fail(["none of the alternatives passed", *all_reasons])

    return _verify


def _temporal_consistent() -> Verifier:
    """Lazy wrapper so the registry stays import-cheap (loads the dated-facts table
    only when used). Catches author-died-before-work impossibilities. See
    agent/temporal_verifier.py."""
    from agent.temporal_verifier import temporal_consistent

    return temporal_consistent()


def _topology_verifier() -> Verifier:
    """Lazy wrapper so the registry stays import-cheap and cycle-free (the gate
    builds a belief graph via agent.wiki_store, which imports this module). Gates a
    PROPOSED belief-graph edit fail-closed. See agent/topology_gate.py."""
    from agent.topology_gate import topology_verifier

    return topology_verifier


# Pop-psych / cross-framework MERGE assertions: claiming a low-validity typology
# (MBTI, Enneagram, DISC, astrology, Type A, left/right brain) IS / equals / maps
# to a Big Five (OCEAN) construct. Mirrors provenance_faithful: an ASSERTED merge
# fails; a correction/negation in the same clause is carved out.
_MERGE_PATTERNS: list[str] = [
    r"\bmbti\b.{0,40}\b(big five|big 5|five[- ]factor|ocean|openness|conscientious|extravers|agreeable|neurotic)",
    r"\b(intj|intp|entj|entp|infj|infp|enfj|enfp|istj|isfj|estj|esfj|istp|isfp|estp|esfp)\b.{0,40}\b(openness|conscientious|extravers|agreeable|neurotic|big five|ocean)",
    r"\btype a\b.{0,30}\b(ocean|big five|dimension|openness|conscientious|extravers|agreeable|neurotic)",
    r"\b(astrolog|horoscope|zodiac|star sign|astrological sign)\b.{0,40}\b(predict|determine|means|conscientious|openness|extravers|agreeable|neurotic|personality trait)",
    r"\b(enneagram|disc)\b.{0,30}\bis\b.{0,20}\b(big five|ocean|five[- ]factor)",
    r"\b(left|right)[- ]brain\b.{0,30}\bpersonality\b",
]
_MERGE_CARVEOUT = [
    r"\bnot\b", r"\bisn't\b", r"\baren't\b", r"\bseparate\b", r"\bdifferent\b",
    r"\bmyth\b", r"\bmisconception\b", r"\bpseudo", r"\blower[- ]validity\b",
    r"\bdebunk", r"\bnot the same\b", r"\bunlike\b",
]


def personality_faithful(spec: "dict | None" = None) -> Verifier:
    """Three-way personality faithfulness (Spec A), mirroring provenance_faithful.

    - ASSERTING a pop-psych/cross-framework MERGE (MBTI=Big Five, astrology
      predicts a trait, Type A is an OCEAN dimension) -> FAIL ("contradicted").
    - require_enactment + target_markers present in text -> "enacted".
    - require_enactment + markers absent -> FAIL ("not expressed").
    - nothing forbidden and no enactment channel -> ABSTAIN (passed True,
      status "abstained", reason notValidated) -- the no-overclaim default.

    NEVER reads spec["mbti"]/spec["ocean"] for the verdict (veneer-invariance).
    """
    from agent.benchmark_checks import matches_any

    spec = spec or {}
    merges = spec.get("forbidden_merges", _MERGE_PATTERNS)
    markers = spec.get("target_markers", [])
    require = bool(spec.get("require_enactment", False))

    def _verify(text: str, task: Any, step: dict) -> dict:
        violations: list[str] = []
        for sentence in re.split(r"[.!?。！？\n]+", text or ""):
            low = sentence.lower()
            if not low.strip():
                continue
            if matches_any(low, _MERGE_CARVEOUT):
                continue  # a correction/negation clause is allowed
            for pat in merges:
                if re.search(pat, low, re.IGNORECASE):
                    violations.append("pop-psych/cross-framework merge")
                    break
        if violations:
            return _fail([f"personality framework-merge asserted: {v}" for v in sorted(set(violations))],
                         {"status": "contradicted", "violations": sorted(set(violations))})
        if markers:
            if matches_any((text or "").lower(), markers):
                return _ok({"status": "enacted", "traitsChecked": len(markers)})
            if require:
                return _fail(["target personality not expressed"],
                             {"status": "contradicted", "markers": markers})
        return _ok({"status": "abstained", "reason": "notValidated"})

    return _verify


personality_discipline = personality_faithful


# Cross-tradition concept-MERGE assertions: claiming a concept from one tradition
# IS / equals / is-a-subclass-of a concept from another tradition ("ren is
# identical to agape", "wu wei ⊑ apatheia"). Mirrors provenance_faithful /
# personality_faithful: an ASSERTED unscoped identity fails; a SCOPED analogy or a
# correction in the same clause is carved out. This is the verifier the report
# found missing — the boundary fact (doNotMergeWith) was dropped upstream before
# any gate could fire. See docs/11-Platform/Ontology-Claim-Boundary.md.
_ONTOLOGY_IDENTITY_PATTERNS: list[str] = [
    r"\bis identical to\b", r"\bis the same as\b", r"\bis the same thing as\b",
    r"\bare the same\b", r"\bis equivalent to\b", r"\bis equal to\b", r"\bequates? to\b",
    r"\bis just\b", r"\bis simply\b", r"\bis merely\b", r"\bis nothing but\b",
    r"\bis basically\b", r"\bis essentially\b",
    r"\bis a subclass of\b", r"\bis a subset of\b", r"\bis a kind of\b", r"\bis a type of\b",
    r"\bis a form of\b", r"\bis a species of\b",
    r"≡", r"⊑", r"\b即\b", r"\b等同(?:於|于)?\b",
]
# A SCOPED analogy or an explicit contrast/negation is allowed — it is exactly the
# admissible form (closeMatch / scopedAnalogy), not a banned bare identity.
_ONTOLOGY_SCOPE_CARVEOUT: list[str] = [
    r"\bresembl", r"\bas if\b", r"\bloosely\b", r"\bby analogy\b", r"\banalog",
    r"\bsimilar to\b", r"\bakin to\b", r"\bcompar", r"\bparallel", r"\becho",
    r"\bwith respect to\b", r"\bin the sense\b", r"\bin some respects?\b",
    r"\bnot\b", r"\bisn't\b", r"\baren't\b", r"\bdiffer", r"\bunlike\b",
    r"\bdistinct\b", r"\bcontrast", r"\bscoped\b", r"\bnuance", r"\bonly partially\b",
]


def ontology_edge_faithful(spec: "dict | None" = None) -> Verifier:
    """Fail if the text asserts an UNSCOPED cross-tradition concept identity /
    subsumption — the concept-TBox analogue of ``provenance_faithful``.

    - ASSERTING an unscoped cross-tradition identity ("ren is identical to agape",
      "wu wei ⊑ apatheia") -> FAIL ("contradicted").
    - A SCOPED analogy ("wu wei resembles apatheia with respect to ...") or an
      explicit contrast/negation ("ren is not agape") -> allowed (carved out).
    - Nothing forbidden -> ABSTAIN (passed True, status "abstained") -- the
      no-overclaim default; this gate never *admits* a cross-tradition claim as
      true (no in-repo ground-truth channel; see the claim-boundary doc).

    Driven by ``data/concept_traditions.json`` (concept -> tradition) so it fires
    on concept-level claims the attribution gate never sees. ``spec`` may override
    ``concept_lexicon`` / ``dnm_by_tradition`` / ``identity_patterns`` for testing.
    """
    from agent.benchmark_checks import matches_any

    spec = spec or {}
    lexicon = spec.get("concept_lexicon") if spec.get("concept_lexicon") is not None else _load_concept_traditions()
    dnm = spec.get("dnm_by_tradition") if spec.get("dnm_by_tradition") is not None else _load_dnm_by_tradition()
    identity_patterns = spec.get("identity_patterns", _ONTOLOGY_IDENTITY_PATTERNS)
    terms_by_len = sorted(lexicon, key=len, reverse=True)

    def _terms_in(clause: str) -> list[tuple[str, str]]:
        found: list[tuple[str, str]] = []
        for term in terms_by_len:
            if re.search(r"\b" + re.escape(term) + r"\b", clause):
                found.append((term, lexicon[term]))
        return found

    def _explicit_dnm(ta: str, tb: str) -> bool:
        return tb in dnm.get(ta, set()) or ta in dnm.get(tb, set())

    def _verify(text: str, task: Any, step: dict) -> dict:
        violations: list[str] = []
        for sentence in re.split(r"[.!?。！？\n]+", text or ""):
            low = sentence.lower()
            if not low.strip():
                continue
            for clause in _carveout_clauses(low):
                if not clause.strip():
                    continue
                if matches_any(clause, _ONTOLOGY_SCOPE_CARVEOUT):
                    continue  # a scoped analogy / contrast — the admissible form
                if not any(re.search(p, clause) for p in identity_patterns):
                    continue
                terms = _terms_in(clause)
                for i in range(len(terms)):
                    for j in range(i + 1, len(terms)):
                        (term_a, ta), (term_b, tb) = terms[i], terms[j]
                        if ta == tb:
                            continue
                        marker = " [doNotMergeWith]" if _explicit_dnm(ta, tb) else ""
                        violations.append(f"{term_a} ({ta}) = {term_b} ({tb}){marker}")
        violations = sorted(set(violations))
        if violations:
            return _fail(
                [f"unscoped cross-tradition identity asserted: {v}" for v in violations],
                {"status": "contradicted", "violations": violations},
            )
        return _ok({"status": "abstained", "reason": "notValidated", "conceptsKnown": len(lexicon)})

    return _verify


ontology_discipline = ontology_edge_faithful


# Parameterless verifiers usable directly by name (CLI / harness registry).
VERIFIERS: dict[str, Callable[[], Verifier]] = {
    "arithmetic_sound": arithmetic_sound,
    "math_sound": math_sound,
    "code_tests_pass": code_tests_pass,
    "provenance_faithful": provenance_faithful,
    "temporal_consistent": _temporal_consistent,
    "frontmatter_schema_valid": frontmatter_schema_valid,
    "legal_citation_exists": legal_citation_exists,
    "personality_faithful": personality_faithful,
    "ontology_edge_faithful": ontology_edge_faithful,
    "topology_verifier": _topology_verifier,
}


def check_text(name: str, text: str) -> dict:
    """Run a registered parameterless verifier over ``text``. CLI/MCP surface."""
    if name not in VERIFIERS:
        raise KeyError(f"unknown verifier {name!r}; known: {', '.join(sorted(VERIFIERS))}")
    return VERIFIERS[name]()(text, None, {})
