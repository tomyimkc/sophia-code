# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Shared benchmark trap checks for scoring and runtime gate."""

from __future__ import annotations

import json
import re
from pathlib import Path

from agent.config import DATA_DIR, ROOT

DENY_PATTERNS = [
    r"^no\b",
    r"\bdid not\b",
    r"\bdidn't\b",
    r"\bnot\b.+\b(discover|invent|coin|write)\b",
    r", not ",
    r"\bnot a direct\b",
    r"\bno writings\b",
    r"\bwrote no\b",
    r"\bleft no extant\b",
    r"\bfalse\b",
    r"\bincorrect\b",
    r"\bmyth\b",
    r"\bmisconception\b",
    r"\bmisattribution\b",
    r"並未",
    r"沒有",
    r"不是",
    r"並非",
    # GF-40: 中文 denial markers seen in failed model runs but missed above.
    # Compound (>=2 char) negations only, so a bare 不/沒 never counts.
    r"並無",
    r"並不",
    r"不曾",
    r"從未",
    r"不準確",
    r"錯誤",
    r"誤歸",
    r"誤傳",
    r"訛傳",
    r"謠傳",
    r"杜撰",
    r"子虛烏有",
]
MYTH_PATTERNS = [
    r"\bmyth\b",
    r"\bmisconception\b",
    r"\bpopular belief\b",
    r"\boversimplif",
    r"\bnot accurate\b",
    r"\bfalse\b",
    r"迷思",
    r"神話",
    r"誤解",
    r"並非",
    r"不正確",
    # GF-40: 中文 myth / fabrication markers from failed model runs.
    r"訛傳",
    r"謠傳",
    r"杜撰",
    r"無稽",
    r"子虛烏有",
    r"誇大",
    r"誤傳",
    r"誤歸",
]
COUNCIL_PATTERNS = [
    r"\bcouncil\b",
    r"\bpanel\b",
    r"theological voice",
    r"historical-critical",
    r"\bdebate\b",
    r"\btension\b",
    r"理事會",
    r"神學",
    r"歷史",
    r"辯論",
    r"張力",
]
SENSITIVE_OK_PATTERNS = [
    r"scholar",
    r"historical",
    r"tradition",
    r"within islam",
    r"穆斯林",
    r"學術",
    r"傳統",
]

AUTHOR_ALIASES: dict[str, list[str]] = {
    "sigmund_freud": ["freud"],
    "leon_festinger": ["festinger"],
    "confucius": ["kongzi", "孔子"],
    "laozi": ["lao tzu", "老子"],
    "socrates": ["蘇格拉底"],
    "plato": ["柏拉圖"],
    "zhuangzi": ["zhuang zhou", "莊子"],
    "mencius": ["meng ke", "孟子"],
}

TRADITION_ALIASES: dict[str, list[str]] = {
    "christianity": ["christian"],
    "buddhism": ["buddhist"],
    "islam": ["muslim", "islamic"],
    "daoist": ["daoism", "taoist", "道家"],
    "confucian": ["confucianism", "儒家"],
    "platonist": ["platonic", "柏拉圖"],
    "stoic": ["stoicism"],
    "mohist": ["mohism", "墨家"],
    "legalist": ["legalism", "法家"],
}

DOMAIN_BENCH: dict[str, Path] = {
    "philosophy": ROOT / "tests" / "benchmark-philosophy.json",
    "psychology": ROOT / "tests" / "benchmark-psychology.json",
    "history": ROOT / "tests" / "benchmark-history.json",
    "religion": ROOT / "tests" / "benchmark-religion.json",
    "personality": ROOT / "tests" / "benchmark-personality.json",
    # Hurdle 2 — structurally different, sound-verifier families (transfer test).
    "math": ROOT / "tests" / "benchmark-math.json",
    "coding": ROOT / "tests" / "benchmark-coding.json",
}

CONFIDENCE_PATTERNS: dict[str, list[str]] = {
    "compiled": [r"compiled", r"assembled", r"students", r"editors", r"彙編", r"編纂", r"弟子"],
    "legendary": [r"uncertain", r"disputed", r"legendary", r"debated", r"存疑", r"不確定", r"傳說", r"爭議"],
    "attributed": [r"attributed", r"traditionally", r"傳統上", r"歸屬",
                   # GF-40: 中文 affirmation markers ("proposed by" / "originates from")
                   r"提出", r"出自", r"由.{0,12}提出", r"相傳", r"傳為", r"託名"],
    "none_extant": [r"no extant", r"wrote no", r"沒有著作", r"未留下"],
}


def load_json(path: Path) -> dict | list:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize(text: str) -> str:
    return text.lower().strip()


def matches_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def tradition_markers(tradition_id: str, traditions: dict) -> list[str]:
    record = traditions.get(tradition_id, {})
    markers = [tradition_id, tradition_id.replace("_", " ")]
    markers.extend(TRADITION_ALIASES.get(tradition_id, []))
    for key in ("labelEn", "labelZh"):
        value = record.get(key)
        if value:
            markers.append(str(value).lower())
    return markers


def author_markers(author_id: str, *, expand_surnames: bool = True) -> list[str]:
    markers = [author_id, author_id.replace("_", " ")]
    markers.extend(AUTHOR_ALIASES.get(author_id, []))
    # Canonical surface-form expansion (surname-only, name orderings, transliterations)
    # so "Tolstoy wrote Crime and Punishment" fires when the record stores "Leo
    # Tolstoy". SAFE ONLY where a co-required title alternation bounds false
    # positives (provenance_faithful's regex). The substring-only score_case path
    # has no title co-match, so it passes expand_surnames=False to avoid a bare
    # surname counting as an author mention on any incidental occurrence.
    if expand_surnames:
        try:
            from agent.entity_aliases import author_surface_forms

            markers += author_surface_forms(author_id)
        except Exception:  # never let the alias layer break the core matcher
            pass
    return list(dict.fromkeys(markers))


def score_case_format(case: dict, response: str, traditions: dict) -> tuple[bool, list[str]]:
    """FORMAT channel: council-panel / debate structure only."""
    reasons: list[str] = []
    text = normalize(response)
    ok = True
    if case.get("mustUseCouncilPanel") and not matches_any(text, COUNCIL_PATTERNS):
        ok = False
        reasons.append("expected council/panel debate format")
    return ok, reasons


def score_case_content(case: dict, response: str, traditions: dict) -> tuple[bool, list[str]]:
    """CONTENT channel: attribution, tradition, nuance, myth labeling, splits, sensitivity."""
    reasons: list[str] = []
    text = normalize(response)
    ok = True

    deny = case.get("mustDenyAttribution")
    if deny:
        author = deny["author"]
        if not any(marker.lower() in text for marker in author_markers(author, expand_surnames=False)):
            ok = False
            reasons.append(f"expected discussion of {author}")
        elif not matches_any(text, DENY_PATTERNS):
            ok = False
            reasons.append(f"expected denial of {author} attribution")

    affirm = case.get("mustAffirmAuthor")
    if affirm:
        author_id = affirm["author"]
        if not any(marker.lower() in text for marker in author_markers(author_id, expand_surnames=False)):
            ok = False
            reasons.append(f"expected mention of correct author '{author_id}'")

    signal = case.get("mustSignalConfidence")
    if signal:
        confidence = signal["confidence"]
        patterns = CONFIDENCE_PATTERNS.get(confidence, [confidence])
        if not matches_any(text, patterns):
            ok = False
            reasons.append(f"expected signal for confidence '{confidence}'")

    if case.get("mustLabelMyth") and not matches_any(text, MYTH_PATTERNS):
        ok = False
        reasons.append("expected myth/misconception labeling")

    if case.get("mustDenyUniversal") and re.search(r"\ball\b.+\b(have|develop|show)\b", text):
        if not matches_any(text, [r"not all", r"rare", r"some", r"並非所有", r"少數", r"部分"]):
            ok = False
            reasons.append("expected rejection of universal claim")

    nuanced = case.get("mustSignalNuanced", [])
    if nuanced and not matches_any(text, nuanced):
        ok = False
        reasons.append(f"expected nuance markers: {nuanced}")

    target = case.get("mustExpressTarget", [])
    if target and not matches_any(text, target):
        ok = False
        reasons.append(f"expected target expression markers: {target}")

    for tradition in case.get("mustMentionTraditions", []):
        markers = tradition_markers(tradition, traditions)
        if not any(marker.lower() in text for marker in markers):
            ok = False
            reasons.append(f"expected tradition context '{tradition}'")

    for subfield in case.get("mustMentionSubfields", []):
        if subfield.replace("_", " ") not in text and subfield not in text:
            if subfield == "pop_myth" and not matches_any(text, [r"pop", r"popular", r"通俗", r"迷思"]):
                ok = False
                reasons.append(f"expected subfield '{subfield}'")

    split = case.get("mustSplitWhenAppropriate")
    if split:
        has_ritual = matches_any(text, [r"ancestor", r"veneration", r"祭祖", r"ritual", r"禮"])
        has_philosophy = matches_any(text, [r"philosoph", r"moral", r"ethic", r"哲學", r"倫理"])
        if not (has_ritual and has_philosophy):
            ok = False
            reasons.append("expected split between Confucian philosophy and ritual religion when appropriate")

    if case.get("mustHandleSensitive"):
        if not matches_any(text, SENSITIVE_OK_PATTERNS):
            ok = False
            reasons.append("expected careful scholarly/traditional handling of sensitive topic")

    return ok, reasons


def score_case_channels(case: dict, response: str, traditions: dict) -> dict:
    """Return separate FORMAT and CONTENT verdicts plus legacy combined pass."""
    fmt_ok, fmt_reasons = score_case_format(case, response, traditions)
    content_ok, content_reasons = score_case_content(case, response, traditions)
    return {
        "formatPassed": fmt_ok,
        "contentPassed": content_ok,
        "passed": fmt_ok and content_ok,
        "formatReasons": fmt_reasons,
        "contentReasons": content_reasons,
        "reasons": fmt_reasons + content_reasons,
    }


def score_case(case: dict, response: str, traditions: dict) -> tuple[bool, list[str]]:
    channels = score_case_channels(case, response, traditions)
    return channels["passed"], channels["reasons"]


def score_domain_channels(domain: str, responses: dict[str, str], traditions: dict) -> dict:
    """Score a full domain benchmark with FORMAT, CONTENT, and COMBINED channels."""
    bench = load_benchmark(domain)
    results = []
    fmt_pass = content_pass = combined_pass = 0
    for case in bench.get("cases", []):
        cid = case["id"]
        ch = score_case_channels(case, responses.get(cid, ""), traditions)
        if ch["formatPassed"]:
            fmt_pass += 1
        if ch["contentPassed"]:
            content_pass += 1
        if ch["passed"]:
            combined_pass += 1
        results.append({"id": cid, **ch})
    total = len(results)
    pct = lambda n: round(100.0 * n / total, 1) if total else 0.0
    return {
        "domain": domain,
        "version": bench.get("version", 1),
        "formatPassed": fmt_pass,
        "contentPassed": content_pass,
        "passed": combined_pass,
        "total": total,
        "formatPct": pct(fmt_pass),
        "contentPct": pct(content_pass),
        "score_pct": pct(combined_pass),
        "results": results,
    }


def load_traditions() -> dict:
    return load_json(DATA_DIR / "traditions.json")


def load_benchmark(domain: str) -> dict:
    path = DOMAIN_BENCH.get(domain)
    if not path or not path.exists():
        return {"cases": []}
    return load_json(path)  # type: ignore[return-value]


def infer_domain(question: str, sources: list[str] | None = None) -> str | None:
    text = question.lower()
    source_text = " ".join(sources or []).lower()
    hints = {
        "philosophy": ["confucius", "socrates", "plato", "laozi", "analects", "republic", "mencius", "zhuangzi", "孔子", "老子", "柏拉圖"],
        "psychology": ["psychology", "freud", "cognitive", "clinical", "pop psych", "心理"],
        "history": ["history", "napoleon", "marco polo", "medieval", "viking", "歷史"],
        "religion": ["religion", "scripture", "gospel", "buddhism", "islam", "宗教", "經文"],
        "personality": ["personality", "mbti", "big five", "ocean", "introvert", "extravert", "openness", "人格", "性格"],
    }
    scores = {domain: 0 for domain in hints}
    for domain, markers in hints.items():
        for marker in markers:
            if marker in text:
                scores[domain] += 2
            if marker in source_text:
                scores[domain] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else None


def match_traps(question: str, *, domain: str) -> list[dict]:
    bench = load_benchmark(domain)
    q = normalize(question)
    matched: list[dict] = []
    for case in bench.get("cases", []):
        case_q = normalize(case.get("question", ""))
        if not case_q:
            continue
        if case_q in q or q in case_q:
            matched.append(case)
            continue
        tokens = [t for t in re.split(r"[^a-z0-9\u4e00-\u9fff]+", case_q) if len(t) > 3]
        if tokens and sum(1 for t in tokens if t in q) >= max(2, len(tokens) // 2):
            matched.append(case)
    return matched


def run_attribution_checks(
    text: str,
    question: str,
    *,
    domain: str | None = None,
) -> tuple[bool, list[dict]]:
    resolved = domain or infer_domain(question) or "philosophy"
    traditions = load_traditions()
    checks: list[dict] = []
    all_ok = True
    for case in match_traps(question, domain=resolved):
        ok, reasons = score_case(case, text, traditions)
        checks.append({"id": case["id"], "passed": ok, "reasons": reasons})
        if not ok:
            all_ok = False
    return all_ok, checks
